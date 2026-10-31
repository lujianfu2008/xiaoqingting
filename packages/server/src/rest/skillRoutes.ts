import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SkillName,
  UpsertSkillRequest,
  ImportSkillsRequest,
  InstallSkillRequest,
  type SkillInfo,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { config } from "../config.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import { searchSkillRegistry } from "../skillRegistry.js";
import {
  SkillsConfigError,
  deleteSkill,
  installSkillFromUrl,
  installSkillMarkdown,
  listGlobalSkills,
  listSkills,
} from "../skillsConfig.js";

// 专家技能管理端点。
// 用户级（/api/skills/*）：安装/删除/导入自己的技能（纯提示包，只影响本人会话）；
// 全局（/api/admin/skills/*）：仅公有域管理员，写审计。技能是注入提示词的内容，
// 全局技能等于替所有用户改模型行为，因此与 stdio MCP 同级对待。写入后丢弃
// 空闲会话，下一条消息用新技能集重建。

function validName(name: string): boolean {
  return SkillName.safeParse(name).success;
}

/** 粘贴导入解析：{"skills":[{"name","markdown"},...]} 或裸的 {名称: markdown}。 */
function parseImportedSkills(json: string): { name: string; markdown: string }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.skills)) {
    return obj.skills
      .filter(
        (e): e is { name: string; markdown: string } =>
          !!e &&
          typeof e === "object" &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).markdown === "string",
      )
      .map((e) => ({ name: e.name, markdown: e.markdown }));
  }
  return Object.entries(obj)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, markdown: v as string }));
}

export function registerSkillRoutes(app: FastifyInstance, manager: AgentManager): void {
  // ---------- 用户级 ----------

  // 生效视图（全局 + 我的，同名以我的为准）。
  app.get("/api/skills", (req) => ({ skills: listSkills(req.userId) }));

  app.put("/api/skills/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      installSkillMarkdown("user", req.userId, name, parsed.data.markdown);
    } catch (e) {
      if (e instanceof SkillsConfigError) return reply.code(400).send({ error: e.code });
      throw e;
    }
    manager.disposeIdleSessions(req.userId);
    return { ok: true };
  });

  app.delete("/api/skills/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!deleteSkill("user", req.userId, name)) {
      return reply.code(404).send({ error: "not_found" });
    }
    manager.disposeIdleSessions(req.userId);
    return reply.code(204).send();
  });

  // 粘贴导入（批量）。
  app.post("/api/skills/import", async (req, reply) => {
    const parsed = ImportSkillsRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const toGlobal = parsed.data.scope === "global";
    if (toGlobal && !isPublicAdmin(req.userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const raw = parseImportedSkills(parsed.data.json);
    if (!raw) return reply.code(400).send({ error: "invalid_json" });

    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const { name, markdown } of raw) {
      try {
        installSkillMarkdown(toGlobal ? "global" : "user", req.userId, name, markdown);
        imported.push(name);
      } catch (e) {
        skipped.push({
          name,
          reason: e instanceof SkillsConfigError ? e.code : "unknown",
        });
      }
    }
    if (imported.length > 0) {
      if (toGlobal) {
        manager.disposeAllIdleSessions();
        appendAudit({
          actor: req.userId,
          action: "skills.global_save",
          target: "-",
          detail: { via: "paste", imported },
        });
      } else {
        manager.disposeIdleSessions(req.userId);
      }
    }
    return { imported, skipped };
  });

  // 从市场安装（服务端下载 SKILL.md；scope=global 仅管理员）。
  app.post("/api/skills/install", async (req, reply) => {
    const parsed = InstallSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const toGlobal = parsed.data.scope === "global";
    if (toGlobal && !isPublicAdmin(req.userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      await installSkillFromUrl(
        toGlobal ? "global" : "user",
        req.userId,
        parsed.data.name,
        parsed.data.url,
      );
    } catch (e) {
      if (e instanceof SkillsConfigError) return reply.code(400).send({ error: e.code });
      throw e;
    }
    if (toGlobal) {
      manager.disposeAllIdleSessions();
      appendAudit({
        actor: req.userId,
        action: "skills.global_save",
        target: parsed.data.name,
        detail: { via: "market" },
      });
    } else {
      manager.disposeIdleSessions(req.userId);
    }
    return { ok: true };
  });

  // 市场搜索（代理 SKILLS_REGISTRY_URL 清单）。
  app.get("/api/skills/registry/search", async (req, reply) => {
    if (!config.skillsRegistryUrl) {
      return reply.code(502).send({ error: "registry_unconfigured" });
    }
    const parsed = z
      .object({
        q: z.string().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      return await searchSkillRegistry(parsed.data.q, parsed.data.limit);
    } catch (e) {
      if (e instanceof SkillsConfigError) return reply.code(502).send({ error: e.code });
      throw e;
    }
  });

  // ---------- 全局（仅公有域管理员） ----------
  app.get("/api/admin/skills", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const skills: SkillInfo[] = listGlobalSkills();
    return { skills };
  });

  app.put("/api/admin/skills/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      installSkillMarkdown("global", req.userId, name, parsed.data.markdown);
    } catch (e) {
      if (e instanceof SkillsConfigError) return reply.code(400).send({ error: e.code });
      throw e;
    }
    manager.disposeAllIdleSessions();
    appendAudit({
      actor: req.userId,
      action: "skills.global_save",
      target: name,
      detail: { via: "paste" },
    });
    return { ok: true };
  });

  app.delete("/api/admin/skills/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!deleteSkill("global", req.userId, name)) {
      return reply.code(404).send({ error: "not_found" });
    }
    manager.disposeAllIdleSessions();
    appendAudit({ actor: req.userId, action: "skills.global_delete", target: name });
    return reply.code(204).send();
  });
}
