import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  McpServerName,
  UpsertMcpServerRequest,
  ImportMcpRequest,
  type McpServerDef,
  type McpServerInfo,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import { searchRegistry } from "../mcpRegistry.js";
import {
  McpConfigError,
  RESERVED_MCP_NAMES,
  assertPublicHttpUrl,
  deleteUserServer,
  getUserServers,
  loadGlobalServers,
  mergeMcpServers,
  normalizeDef,
  parseImportedServers,
  saveGlobalServers,
  setUserServer,
} from "../mcpConfig.js";

// MCP 服务器管理端点。
// 用户级（/api/mcp/*）：仅远程 http/sse，URL 做私网过滤防 SSRF；
// 全局（/api/admin/mcp/*）：仅公有域管理员，允许 stdio（服务器上 spawn 子进程
// 等价服务器执行权限）。写入后丢弃空闲会话，下一条消息用新配置重建。

function validName(name: string): boolean {
  return McpServerName.safeParse(name).success && !RESERVED_MCP_NAMES.has(name);
}

/** 客户端视图：全局条目隐藏 header 值（可能含 token），只标记是否含鉴权头。 */
function toClientView(
  name: string,
  def: McpServerDef,
  source: "user" | "global",
  overridesGlobal: boolean,
): McpServerInfo {
  if (source === "global") {
    const hasHeaders = !!def.headers && Object.keys(def.headers).length > 0;
    const { headers: _hidden, ...rest } = def;
    return { ...rest, name, source, headers_redacted: hasHeaders || undefined };
  }
  return {
    ...def,
    name,
    source,
    overrides_global: overridesGlobal || undefined,
  };
}

/** 生效视图（全局 + 我的，同名以我的为准），供设置面板展示。 */
function listMerged(username: string): McpServerInfo[] {
  const { servers, userOverrides } = mergeMcpServers(username);
  const mine = new Set(Object.keys(getUserServers(username)));
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) =>
      mine.has(name)
        ? toClientView(name, def, "user", userOverrides.has(name))
        : toClientView(name, def, "global", false),
    );
}

/** 导入条目逐项校验，返回跳过原因（null = 通过）。 */
async function checkImportEntry(
  name: string,
  entry: unknown,
  toGlobal: boolean,
): Promise<string | null> {
  if (!McpServerName.safeParse(name).success) return "invalid_name";
  if (RESERVED_MCP_NAMES.has(name)) return "reserved_name";
  const def = normalizeDef(entry);
  if (!def) return "invalid_def";
  if ((def.type === "http" || def.type === "sse") && !def.url?.trim()) return "invalid_def";
  if (!toGlobal) {
    // stdio 只进全局（管理员）；远程 URL 过 SSRF。
    if (def.type === "stdio") return "stdio_forbidden";
    try {
      await assertPublicHttpUrl(def.url!.trim());
    } catch (e) {
      if (e instanceof McpConfigError) return e.code;
      throw e;
    }
  }
  return null;
}

export function registerMcpRoutes(app: FastifyInstance, manager: AgentManager): void {
  // ---------- 用户级（远程 http/sse，存 data/mcp-users.json） ----------

  app.get("/api/mcp/servers", (req) => ({ servers: listMerged(req.userId) }));

  app.put("/api/mcp/servers/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertMcpServerRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.type === "stdio") {
      return reply.code(400).send({ error: "stdio_forbidden" });
    }
    try {
      await assertPublicHttpUrl(parsed.data.url!.trim());
    } catch (e) {
      if (e instanceof McpConfigError) return reply.code(400).send({ error: e.code });
      throw e;
    }
    setUserServer(req.userId, name, parsed.data);
    manager.disposeIdleSessions(req.userId);
    return toClientView(name, parsed.data, "user", name in loadGlobalServers());
  });

  app.delete("/api/mcp/servers/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!deleteUserServer(req.userId, name)) {
      return reply.code(404).send({ error: "not_found" });
    }
    manager.disposeIdleSessions(req.userId);
    return reply.code(204).send();
  });

  // 粘贴导入（主流 MCP 客户端/市场的配置片段）。
  app.post("/api/mcp/import", async (req, reply) => {
    const parsed = ImportMcpRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const toGlobal = parsed.data.scope === "global";
    if (toGlobal && !isPublicAdmin(req.userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const raw = parseImportedServers(parsed.data.json);
    if (!raw) return reply.code(400).send({ error: "invalid_json" });

    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const global = toGlobal ? loadGlobalServers() : null;
    for (const [name, entry] of Object.entries(raw)) {
      const reason = await checkImportEntry(name, entry, toGlobal);
      if (reason) {
        skipped.push({ name, reason });
        continue;
      }
      const def = normalizeDef(entry)!;
      if (global) global[name] = def;
      else setUserServer(req.userId, name, def);
      imported.push(name);
    }
    if (imported.length > 0) {
      if (global) {
        saveGlobalServers(global);
        manager.disposeAllIdleSessions();
        // 审计只记名称清单，绝不记 headers（可能含 token）。
        appendAudit({
          actor: req.userId,
          action: "mcp.global_save",
          target: "-",
          detail: { imported },
        });
      } else {
        manager.disposeIdleSessions(req.userId);
      }
    }
    return { imported, skipped };
  });

  // 官方 MCP Registry 市场搜索（代理，规避 CORS；安装仍走上面的写入端点）。
  app.get("/api/mcp/registry/search", async (req, reply) => {
    const parsed = z
      .object({
        q: z.string().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().max(300).optional(),
      })
      .safeParse((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      return await searchRegistry(parsed.data.q, parsed.data.limit, parsed.data.cursor);
    } catch (e) {
      if (e instanceof McpConfigError) return reply.code(502).send({ error: e.code });
      throw e;
    }
  });

  // ---------- 全局（仅公有域管理员，存 data/mcp.json，任意传输类型） ----------
  app.get("/api/admin/mcp/servers", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const servers = Object.entries(loadGlobalServers())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, def]) => ({ ...def, name, source: "global" as const }));
    return { servers };
  });

  app.put("/api/admin/mcp/servers/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertMcpServerRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const map = loadGlobalServers();
    map[name] = parsed.data;
    saveGlobalServers(map);
    manager.disposeAllIdleSessions();
    appendAudit({
      actor: req.userId,
      action: "mcp.global_save",
      target: name,
      detail: { type: parsed.data.type },
    });
    return { ...parsed.data, name, source: "global" as const };
  });

  app.delete("/api/admin/mcp/servers/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    const map = loadGlobalServers();
    if (!(name in map)) return reply.code(404).send({ error: "not_found" });
    delete map[name];
    saveGlobalServers(map);
    manager.disposeAllIdleSessions();
    appendAudit({ actor: req.userId, action: "mcp.global_delete", target: name });
    return reply.code(204).send();
  });
}
