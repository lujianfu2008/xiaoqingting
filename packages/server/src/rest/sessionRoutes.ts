import type { FastifyInstance } from "fastify";
import {
  ChangePasswordRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  MoveSessionRequest,
  RenameSessionRequest,
  SessionSearchQuery,
  SetProjectDescriptionRequest,
  ShareSessionRequest,
} from "@blm/protocol";
import { blocksToMarkdown } from "./exportMarkdown.js";
import type { AgentManager } from "../agent/AgentManager.js";
import { listRoles } from "../agent/agents.js";
import {
  listUsers,
  getEmployeeId,
  isPublicAdmin,
  getRole,
  getUserRecord,
  changePassword,
} from "../users.js";
import { searchUserSessions } from "./sessionSearch.js";

// Identity, agents and session CRUD/sharing endpoints.

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: AgentManager,
): void {
  app.get("/api/agents", () => listRoles());

  // Server-confirmed identity: lets a client with a stale local cache (or an
  // old token that predates 工号) refresh what to display.
  app.get("/api/me", (req) => ({
    username: req.userId,
    employee_id: getEmployeeId(req.userId),
    role: getRole(req.userId),
  }));

  // 本人修改密码：验证旧密码；成功后此前签发的 token 全部失效（需重新登录）。
  app.post("/api/me/password", (req, reply) => {
    const parsed = ChangePasswordRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = changePassword(req.userId, parsed.data.old_password, parsed.data.new_password);
    if (result === "bootstrap") return reply.code(400).send({ error: "bootstrap_password_env" });
    if (result === "bad_credentials") return reply.code(403).send({ error: "bad_credentials" });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.get("/api/sessions", (req) => manager.listSessions(req.userId));

  // 会话内容全文搜索（只扫本人会话；60s 内存缓存防抖）。
  // 注册在 /api/sessions/:id 之前：避免 "search" 被当成 id。
  app.get("/api/sessions/search", (req, reply) => {
    const parsed = SessionSearchQuery.safeParse((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return searchUserSessions(manager, req.userId, parsed.data.q, parsed.data.limit ?? 20);
  });

  app.post("/api/sessions", (req, reply) => {
    const parsed = CreateSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    // A project-bound session defaults to the project's own agent role.
    const projectId = parsed.data.project_id ?? null;
    let agentId = parsed.data.agent_id ?? "assistant";
    if (projectId) {
      const proj = manager
        .listProjects(req.userId)
        .find((p) => p.project_id === projectId);
      if (!proj) return reply.code(404).send({ error: "project_not_found" });
      agentId = parsed.data.agent_id ?? proj.agent_id;
    }
    const rec = manager.createSession(req.userId, agentId, parsed.data.title, projectId);
    if (!rec) return reply.code(404).send({ error: "project_not_found" });
    return reply.code(201).send({
      session_id: rec.session_id,
      title: rec.title,
      agent_id: rec.agent_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      project_id: rec.project_id ?? null,
    });
  });

  // ---------- projects ----------

  app.get("/api/projects", (req) => manager.listProjects(req.userId));

  app.post("/api/projects", (req, reply) => {
    const parsed = CreateProjectRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const visibility = parsed.data.visibility ?? "personal";
    if (visibility === "public" && !isPublicAdmin(req.userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const rec = manager.createProject(
      req.userId,
      parsed.data.name.trim(),
      parsed.data.agent_id ?? "assistant",
      visibility,
      parsed.data.description,
    );
    return reply.code(201).send({
      project_id: rec.project_id,
      name: rec.name,
      agent_id: rec.agent_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      visibility: rec.visibility,
      owner: rec.user_id,
      ...(rec.description ? { description: rec.description } : {}),
    });
  });

  app.delete("/api/projects/:id", (req, reply) => {
    const result = manager.deleteProject(req.userId, (req.params as { id: string }).id);
    if (result.ok) return reply.code(204).send();
    return reply.code(result.code === "forbidden" ? 403 : 404).send({ error: result.code });
  });

  // 设置项目描述（个人项目=本人；公有域项目=公有域管理员）。空串 = 清空。
  app.post("/api/projects/:id/description", (req, reply) => {
    const parsed = SetProjectDescriptionRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = manager.setProjectDescription(
      req.userId,
      (req.params as { id: string }).id,
      parsed.data.description,
    );
    if (!result.ok) {
      return reply
        .code(result.code === "forbidden" ? 403 : 404)
        .send({ error: result.code });
    }
    return {
      project_id: result.rec.project_id,
      description: result.rec.description ?? "",
      updated_at: result.rec.updated_at,
    };
  });

  app.get("/api/sessions/:id/messages", (req, reply) => {
    const history = manager.getHistory(req.userId, (req.params as { id: string }).id);
    if (!history) return reply.code(404).send({ error: "not_found" });
    return history;
  });

  // 导出会话为 Markdown 下载（归属与 messages 一致：本人或共享可见）。
  app.get("/api/sessions/:id/export", (req, reply) => {
    const history = manager.getHistory(req.userId, (req.params as { id: string }).id);
    if (!history) return reply.code(404).send({ error: "not_found" });
    const md = blocksToMarkdown(history.session, history.blocks);
    // 标题里的非法文件名字符替换为 _（中文保留），空标题回退会话 id。
    // HTTP 头只允许 ISO-8859-1：ASCII 兜底名 + RFC 6266 的
    // filename*（UTF-8 百分号编码）携带原中文标题。
    const safeName =
      history.session.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 100) ||
      history.session.session_id;
    const asciiFallback = /[^\x20-\x7e]/.test(safeName)
      ? "session-export"
      : safeName;
    const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}.md"; filename*=UTF-8''${encoded}.md`,
    );
    return reply.send(md);
  });

  app.delete("/api/sessions/:id", (req, reply) => {
    // 发起方（会话主人）随时可删；在途协作任务由服务端强制收尾为取消。
    const result = manager.deleteSession(req.userId, (req.params as { id: string }).id);
    if (result.ok) return reply.code(204).send();
    return reply.code(404).send({ error: "not_found" });
  });

  // Move a session into another project (or back to the default space with
  // project_id: null). The engine keeps running — only grouping changes.
  // 个人↔公域之间禁止移动（两者的工具集不同）。
  app.post("/api/sessions/:id/move", (req, reply) => {
    const parsed = MoveSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = manager.moveSession(
      req.userId,
      (req.params as { id: string }).id,
      parsed.data.project_id,
    );
    if (!result.ok) {
      if (result.code === "cross_visibility") {
        return reply.code(400).send({ error: "cross_visibility", message: "不能在个人项目与公有域项目之间移动会话" });
      }
      return reply.code(404).send({ error: "not_found" });
    }
    return { session_id: result.rec.session_id, project_id: result.rec.project_id ?? null };
  });

  // 重命名自己的会话（仅标题）。
  app.post("/api/sessions/:id/title", (req, reply) => {
    const parsed = RenameSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = manager.renameSession(req.userId, (req.params as { id: string }).id, parsed.data.title);
    if (!result.ok) {
      return reply
        .code(result.code === "forbidden" ? 403 : 404)
        .send({ error: result.code });
    }
    return { session_id: result.rec.session_id, title: result.rec.title };
  });

  // Knowledge sharing: toggle sharing of one of my sessions, optionally
  // restricted to a list of usernames (empty/absent list = everyone).
  // approvers：可代为确认审批的成员（在线时同步收到审批弹窗）。
  app.post("/api/sessions/:id/share", (req, reply) => {
    const parsed = ShareSessionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { shared, shared_with, approvers } = parsed.data;
    const rec = manager.setShared(req.userId, (req.params as { id: string }).id, shared, shared_with, approvers);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return {
      session_id: rec.session_id,
      shared: rec.shared ?? false,
      shared_with: rec.shared_with ?? [],
      approvers: rec.approvers ?? [],
    };
  });

  // Sessions other users have shared with me.
  app.get("/api/shared", (req) => manager.listSharedSessions(req.userId));

  // All users (for picking share targets) with 工号 and live presence.
  app.get("/api/users", () => ({
    users: listUsers().map((u) => ({
      ...u,
      role: getRole(u.username),
      disabled: getUserRecord(u.username)?.disabled ?? false,
      online: manager.isOnline(u.username),
    })),
  }));
}
