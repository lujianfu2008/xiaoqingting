import type { FastifyInstance } from "fastify";
import {
  CreateProjectRequest,
  CreateSessionRequest,
  MoveSessionRequest,
  ShareSessionRequest,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { listRoles } from "../agent/agents.js";
import { listUsers, getEmployeeId, isPublicAdmin, getUserRecord } from "../users.js";

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
    role: isPublicAdmin(req.userId) ? "admin" : "user",
  }));

  app.get("/api/sessions", (req) => manager.listSessions(req.userId));

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
    );
    return reply.code(201).send({
      project_id: rec.project_id,
      name: rec.name,
      agent_id: rec.agent_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      visibility: rec.visibility,
      owner: rec.user_id,
    });
  });

  app.delete("/api/projects/:id", (req, reply) => {
    const result = manager.deleteProject(req.userId, (req.params as { id: string }).id);
    if (result.ok) return reply.code(204).send();
    return reply.code(result.code === "forbidden" ? 403 : 404).send({ error: result.code });
  });

  app.get("/api/sessions/:id/messages", (req, reply) => {
    const history = manager.getHistory(req.userId, (req.params as { id: string }).id);
    if (!history) return reply.code(404).send({ error: "not_found" });
    return history;
  });

  app.delete("/api/sessions/:id", (req, reply) => {
    const ok = manager.deleteSession(req.userId, (req.params as { id: string }).id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
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

  // Knowledge sharing: toggle sharing of one of my sessions, optionally
  // restricted to a list of usernames (empty/absent list = everyone).
  app.post("/api/sessions/:id/share", (req, reply) => {
    const parsed = ShareSessionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { shared, shared_with } = parsed.data;
    const rec = manager.setShared(req.userId, (req.params as { id: string }).id, shared, shared_with);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return { session_id: rec.session_id, shared: rec.shared ?? false, shared_with: rec.shared_with ?? [] };
  });

  // Sessions other users have shared with me.
  app.get("/api/shared", (req) => manager.listSharedSessions(req.userId));

  // All users (for picking share targets) with 工号 and live presence.
  app.get("/api/users", () => ({
    users: listUsers().map((u) => ({
      ...u,
      role: isPublicAdmin(u.username) ? ("admin" as const) : ("user" as const),
      disabled: getUserRecord(u.username)?.disabled ?? false,
      online: manager.isOnline(u.username),
    })),
  }));
}
