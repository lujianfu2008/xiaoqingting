import type { FastifyInstance } from "fastify";
import {
  AdminUsersResponse,
  DisabledUpdateRequest,
  RoleUpdateRequest,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import {
  listUsers,
  getEmployeeId,
  getUserRecord,
  isPublicAdmin,
  isBootstrapAdmin,
  setRole,
  setDisabled,
} from "../users.js";

// 管理员专用：用户管理（公有域管理员授权、账号禁用/启用）。
// 注册在 JWT 钩子之后，所有端点要求调用者本身是公有域管理员。

export function registerAdminRoutes(app: FastifyInstance, manager: AgentManager): void {
  // 全量用户列表（工号/角色/禁用/在线/创建时间），供管理页使用。
  app.get("/api/admin/users", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const body: AdminUsersResponse = {
      users: listUsers().map((u) => {
        const rec = getUserRecord(u.username);
        return {
          username: u.username,
          employee_id: u.employee_id,
          role: rec?.role ?? "user",
          disabled: rec?.disabled ?? false,
          created_at: rec?.created_at,
          online: manager.isOnline(u.username),
          immutable: isBootstrapAdmin(u.username),
        };
      }),
    };
    return body;
  });

  // 授予/回收公有域管理员角色。bootstrap admin 不可改。
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
    return { username, disabled: parsed.data.disabled };
  });
}
