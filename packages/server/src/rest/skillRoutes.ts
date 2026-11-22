import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SkillName,
  UpsertSkillRequest,
  ImportSkillsRequest,
  ImportArchiveRequest,
  InstallSkillRequest,
  EnableSkillRequest,
  SkillMarkdownResponse,
  type SkillInfo,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { config } from "../config.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import { searchSkillRegistry, zhCardFor } from "../skillRegistry.js";
import { translateToZh } from "../translate.js";
import {
  SkillsConfigError,
  deleteSkill,
  installSkillFromUrl,
  installSkillMarkdown,
  installSkillsFromArchive,
  listGlobalSkills,
  listSkills,
  readSkillMarkdown,
  setSkillEnabled,
  type ArchiveInstallResult,
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

  // 已安装列表本地化：lang=zh 时官方收录技能用中文策展文案，其余经 LLM
  // 批量翻译（translate.ts 内缓存，失败回原文）；lang 缺省/en 返回原文。
  async function localizeSkills(
    username: string,
    skills: SkillInfo[],
    lang?: "zh" | "en",
  ): Promise<SkillInfo[]> {
    if (lang !== "zh" || skills.length === 0) return skills;
    const curated = skills.map((s) => zhCardFor(s.name));
    const tr = await translateToZh(
      username,
      skills.map((s, i) => (curated[i] ? "" : (s.description ?? ""))),
    );
    return skills.map((s, i) => ({
      ...s,
      ...(curated[i] ? { title: curated[i]!.title } : {}),
      description: curated[i]?.desc || tr[i] || s.description,
    }));
  }

  // 生效视图（全局 + 我的，同名以我的为准）。
  app.get("/api/skills", async (req) => {
    const lang = z
      .enum(["zh", "en"])
      .safeParse((req.query as Record<string, unknown> | undefined)?.lang);
    const skills = await localizeSkills(
      req.userId,
      listSkills(req.userId),
      lang.success ? lang.data : undefined,
    );
    return { skills };
  });

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

  // 读技能全文（编辑表单预填）。
  app.get("/api/skills/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const markdown = readSkillMarkdown("user", req.userId, name);
    if (markdown === null) return reply.code(404).send({ error: "not_found" });
    return { markdown };
  });

  // 启用/停用（配置保留；停用不挂会话、不可斜杠呼叫）。
  app.post("/api/skills/:name/enabled", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = EnableSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!setSkillEnabled("user", req.userId, name, parsed.data.enabled)) {
      return reply.code(404).send({ error: "not_found" });
    }
    manager.disposeIdleSessions(req.userId);
    return { ok: true };
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

  // 压缩包安装：zip 内容 base64 随 JSON 上传。布局自适应（单技能/多技能/
  // GitHub 整仓自动剥包装层）；每技能只提取 SKILL.md（纯提示包边界，带脚本
  // 的技能组整组跳过）。scope=global 仅管理员。
  app.post(
    "/api/skills/import-archive",
    { bodyLimit: 32 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = ImportArchiveRequest.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const toGlobal = parsed.data.scope === "global";
      if (toGlobal && !isPublicAdmin(req.userId)) {
        return reply.code(403).send({ error: "forbidden" });
      }
      let result: ArchiveInstallResult;
      try {
        result = installSkillsFromArchive(
          toGlobal ? "global" : "user",
          req.userId,
          Buffer.from(parsed.data.archive, "base64"),
          parsed.data.filename ?? "",
        );
      } catch (e) {
        if (e instanceof SkillsConfigError) return reply.code(400).send({ error: e.code });
        throw e;
      }
      if (result.imported.length > 0) {
        if (toGlobal) {
          manager.disposeAllIdleSessions();
          appendAudit({
            actor: req.userId,
            action: "skills.global_save",
            target: "-",
            detail: { via: "archive", imported: result.imported },
          });
        } else {
          manager.disposeIdleSessions(req.userId);
        }
      }
      return result;
    },
  );

  // 从市场安装（服务端下载 SKILL.md；scope=global 仅管理员）。
  app.post("/api/skills/install", async (req, reply) => {
    const parsed = InstallSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const toGlobal = parsed.data.scope === "global";
    if (toGlobal && !isPublicAdmin(req.userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    let installedName: string;
    try {
      installedName = await installSkillFromUrl(
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
        target: installedName,
        detail: { via: "market" },
      });
    } else {
      manager.disposeIdleSessions(req.userId);
    }
    // 最终落库名随响应返回（服务端可能做了 frontmatter 优先/规范化），
    // 客户端以它为准展示「已安装为 xxx」。
    return { ok: true as const, name: installedName };
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
        lang: z.enum(["zh", "en"]).optional(),
      })
      .safeParse((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      return await searchSkillRegistry(parsed.data.q, parsed.data.limit, parsed.data.lang);
    } catch (e) {
      if (e instanceof SkillsConfigError) return reply.code(502).send({ error: e.code });
      throw e;
    }
  });

  // ---------- 全局（仅公有域管理员） ----------
  app.get("/api/admin/skills", async (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const lang = z
      .enum(["zh", "en"])
      .safeParse((req.query as Record<string, unknown> | undefined)?.lang);
    const skills = await localizeSkills(
      req.userId,
      listGlobalSkills(),
      lang.success ? lang.data : undefined,
    );
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

  app.get("/api/admin/skills/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const markdown = readSkillMarkdown("global", req.userId, name);
    if (markdown === null) return reply.code(404).send({ error: "not_found" });
    return { markdown };
  });

  app.post("/api/admin/skills/:name/enabled", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = EnableSkillRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!setSkillEnabled("global", req.userId, name, parsed.data.enabled)) {
      return reply.code(404).send({ error: "not_found" });
    }
    manager.disposeAllIdleSessions();
    appendAudit({
      actor: req.userId,
      action: "skills.global_toggle",
      target: name,
      detail: { enabled: parsed.data.enabled },
    });
    return { ok: true };
  });
}
