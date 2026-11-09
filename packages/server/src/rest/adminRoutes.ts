import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AdminUserDetail,
  AdminUsersResponse,
  AdminResetPasswordRequest,
  DisabledUpdateRequest,
  PublicExecToggleRequest,
  ReviewDecisionRequest,
  RoleUpdateRequest,
} from "@blm/protocol";
import type { AuditEntry } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { appendAudit, readRecentAudit } from "../audit.js";
import {
  listUsers,
  getEmployeeId,
  getUserRecord,
  isPublicAdmin,
  isBootstrapAdmin,
  canReview,
  setRole,
  setDisabled,
  setStatus,
  resetPassword,
} from "../users.js";
import { isPublicExecAuthorized, setPublicExecAuthorized } from "../publicExecAuth.js";

// 管理员专用：用户管理（公有域管理员授权、审核员授权、账号禁用/启用）。
// 注册审核端点（/api/review/*）对管理员和管理员授权的审核员（reviewer）开放。
// 管理端点注册在 JWT 钩子之后，要求调用者是公有域管理员。

export function registerAdminRoutes(app: FastifyInstance, manager: AgentManager): void {
  const toDetail = (u: { username: string; employee_id: string }): AdminUserDetail => {
    const rec = getUserRecord(u.username);
    return {
      username: u.username,
      employee_id: u.employee_id,
      role: rec?.role ?? "user",
      disabled: rec?.disabled ?? false,
      status: rec?.status ?? "approved",
      created_at: rec?.created_at,
      online: manager.isOnline(u.username),
      immutable: isBootstrapAdmin(u.username),
      public_exec: isPublicExecAuthorized(u.username),
    };
  };

  // 全量用户列表（工号/角色/审核状态/禁用/在线/创建时间），供管理页使用。
  app.get("/api/admin/users", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const body: AdminUsersResponse = {
      users: listUsers().map(toDetail),
    };
    return body;
  });

  // 授予/回收角色（admin=公有域管理员，reviewer=注册审核员）。bootstrap admin 不可改。
  app.post("/api/admin/users/:username/role", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = RoleUpdateRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const username = (req.params as { username: string }).username;
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    if (isBootstrapAdmin(username)) {
      return reply.code(400).send({ error: "immutable_account" });
    }
    if (!setRole(username, parsed.data.role)) {
      return reply.code(400).send({ error: "update_failed" });
    }
    appendAudit({ actor: req.userId, action: "user.role_change", target: username, detail: { role: parsed.data.role } });
    return { username, role: parsed.data.role };
  });

  // 禁用/启用账号。禁用立即生效（REST 拒绝 + 强制下线）。bootstrap admin 不可禁用。
  app.post("/api/admin/users/:username/disabled", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = DisabledUpdateRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const username = (req.params as { username: string }).username;
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    if (isBootstrapAdmin(username)) {
      return reply.code(400).send({ error: "immutable_account" });
    }
    if (!setDisabled(username, parsed.data.disabled)) {
      return reply.code(400).send({ error: "update_failed" });
    }
    if (parsed.data.disabled) manager.dropUser(username);
    appendAudit({
      actor: req.userId,
      action: parsed.data.disabled ? "user.disable" : "user.enable",
      target: username,
    });
    return { username, disabled: parsed.data.disabled };
  });

  // 公有域服务端执行授权：被授权工号可在公有域会话里用 run_command
  // 在服务器工作空间内执行命令。变更后丢弃该用户空闲会话，下一条
  // 消息按新工具集重建。bootstrap admin 天然授权，无需开关。
  app.post("/api/admin/users/:username/public-exec", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = PublicExecToggleRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const username = (req.params as { username: string }).username;
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    setPublicExecAuthorized(username, parsed.data.enabled);
    appendAudit({
      actor: req.userId,
      action: "public.exec_auth_change",
      target: username,
      detail: { enabled: parsed.data.enabled },
    });
    manager.disposeIdleSessions(username);
    return { username, public_exec: parsed.data.enabled };
  });

  // 重置密码（无需旧密码）。目标用户的所有旧 token 立即失效并被强制下线。
  // bootstrap admin 的密码在服务端 .env（BLMA_PASSWORD），不在本接口范围内。
  app.post("/api/admin/users/:username/password", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = AdminResetPasswordRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const username = (req.params as { username: string }).username;
    if (isBootstrapAdmin(username)) {
      return reply.code(400).send({ error: "bootstrap_password_env" });
    }
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    if (!resetPassword(username, parsed.data.password)) {
      return reply.code(400).send({ error: "update_failed" });
    }
    manager.dropUser(username);
    // 审计只记动作与目标，绝不记密码明文/哈希。
    appendAudit({ actor: req.userId, action: "user.reset_password", target: username });
    return { username };
  });

  // 强制下线（不禁用账号，仅断开其全部连接）。bootstrap admin 不可被踢。
  app.post("/api/admin/users/:username/kick", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const username = (req.params as { username: string }).username;
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    if (isBootstrapAdmin(username)) {
      return reply.code(400).send({ error: "immutable_account" });
    }
    if (username === req.userId) {
      return reply.code(400).send({ error: "cannot_kick_self" });
    }
    manager.kickUser(username);
    appendAudit({ actor: req.userId, action: "user.kick", target: username });
    return { username, kicked: true };
  });

  // ---------- 注册审核（管理员 + 其授权的审核员） ----------

  // 待审核用户列表。
  app.get("/api/review/users", (req, reply) => {
    if (!canReview(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const body: AdminUsersResponse = {
      users: listUsers().map(toDetail).filter((u) => u.status === "pending"),
    };
    return body;
  });

  // 通过/拒绝注册申请。拒绝立即生效（强制下线，防止旧 token 继续使用）；
  // 对已拒绝的用户可通过重新通过恢复登录。
  app.post("/api/review/users/:username/decide", (req, reply) => {
    if (!canReview(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = ReviewDecisionRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const username = (req.params as { username: string }).username;
    if (isBootstrapAdmin(username)) {
      return reply.code(400).send({ error: "immutable_account" });
    }
    if (!getUserRecord(username)) return reply.code(404).send({ error: "not_found" });
    const status = parsed.data.approve ? "approved" : "rejected";
    if (!setStatus(username, status)) {
      return reply.code(400).send({ error: "update_failed" });
    }
    if (!parsed.data.approve) manager.dropUser(username);
    appendAudit({
      actor: req.userId,
      action: parsed.data.approve ? "review.approve" : "review.reject",
      target: username,
    });
    return { username, status };
  });

  // 审计日志（最近 N 条，倒序）。仅公有域管理员。
  app.get("/api/admin/audit", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(
      (req.query ?? {}) as Record<string, unknown>,
    );
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const entries: AuditEntry[] = readRecentAudit(parsed.data.limit);
    return { entries };
  });
}
