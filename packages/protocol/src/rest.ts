import { z } from "zod";
import { Block } from "./blocks.js";
import { SessionMeta } from "./sessions.js";
// ---------- REST ----------

// 用户角色：admin = 公有域管理员（可创建公域项目、审批更新申请、管理用户）；
// reviewer = 管理员授权的注册审核员（仅可审批新用户注册）。
export const Role = z.enum(["admin", "reviewer", "user"]);
export type Role = z.infer<typeof Role>;

// 注册审核状态：新注册账号为 pending，审核通过（approved）后才能登录使用；
// rejected = 已拒绝。旧账号无此字段，服务端一律视为 approved。
export const UserStatus = z.enum(["pending", "approved", "rejected"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const LoginRequest = z.object({
  username: z.string(),
  password: z.string(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  token: z.string(),
  username: z.string(),
  employee_id: z.string(),
  role: Role,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RegisterRequest = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(64),
  // Display-only 工号; older clients omit it and the server falls back to username.
  employee_id: z.string().min(2).max(32).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

// Registration no longer signs the user in: new accounts land in "pending"
// review and the client shows a wait screen instead of a token.
export const RegisterResponse = z.object({
  username: z.string(),
  employee_id: z.string(),
  status: UserStatus,
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

// Server-confirmed identity (used to refresh a local cache or an old token).
export const MeResponse = z.object({
  username: z.string(),
  employee_id: z.string(),
  role: Role,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UserSummary = z.object({
  username: z.string(),
  employee_id: z.string(),
  online: z.boolean(),
  role: Role,
  disabled: z.boolean().optional(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const UsersResponse = z.object({
  users: z.array(UserSummary),
});
export type UsersResponse = z.infer<typeof UsersResponse>;

export const CreateSessionRequest = z.object({
  title: z.string().optional(),
  agent_id: z.string().optional(),
  // Create the session inside a project owned by the caller.
  project_id: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

// REST: move a session into another project; null = back to the default space.
export const MoveSessionRequest = z.object({
  project_id: z.string().nullable(),
});
export type MoveSessionRequest = z.infer<typeof MoveSessionRequest>;

// REST: rename a session (owner only).
export const RenameSessionRequest = z.object({
  title: z.string().trim().min(1).max(100),
});
export type RenameSessionRequest = z.infer<typeof RenameSessionRequest>;

// REST: create a named project space (sessions then attach to it).
export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(64),
  agent_id: z.string().optional(),
  // "public" = 公有域项目（文件存服务端工作空间），仅公有域管理员可创建。
  visibility: z.enum(["personal", "public"]).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// REST: toggle sharing of one of my sessions (owner only).
export const ShareSessionRequest = z.object({
  shared: z.boolean(),
  shared_with: z.array(z.string()).optional(),
});
export type ShareSessionRequest = z.infer<typeof ShareSessionRequest>;

export const SessionHistory = z.object({
  session: SessionMeta,
  blocks: z.array(Block),
});
export type SessionHistory = z.infer<typeof SessionHistory>;

// ---------- 管理员：用户管理（仅公有域管理员可调用） ----------

export const AdminUserDetail = z.object({
  username: z.string(),
  employee_id: z.string(),
  role: Role,
  disabled: z.boolean(),
  // 注册审核状态（旧服务端不返回，视为 approved）。
  status: UserStatus.optional(),
  created_at: z.string().optional(),
  // 由服务端按当前 WS 连接补齐。
  online: z.boolean().optional(),
  // 内置（bootstrap）管理员：不可降级/禁用，客户端据此隐藏操作。
  immutable: z.boolean().optional(),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

export const AdminUsersResponse = z.object({
  users: z.array(AdminUserDetail),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponse>;

export const RoleUpdateRequest = z.object({ role: Role });
export type RoleUpdateRequest = z.infer<typeof RoleUpdateRequest>;

export const DisabledUpdateRequest = z.object({ disabled: z.boolean() });
export type DisabledUpdateRequest = z.infer<typeof DisabledUpdateRequest>;

// ---------- 注册审核（管理员 + 其授权的审核员） ----------

export const ReviewDecisionRequest = z.object({ approve: z.boolean() });
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequest>;

// ---------- 账户信息修改 ----------

// 本人改密：需验证旧密码；成功后该用户此前签发的所有 token 立即失效。
export const ChangePasswordRequest = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(6).max(64),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

// 管理员重置密码：无需旧密码；目标用户的所有 token 立即失效并被强制下线。
export const AdminResetPasswordRequest = z.object({
  password: z.string().min(6).max(64),
});
export type AdminResetPasswordRequest = z.infer<typeof AdminResetPasswordRequest>;

// ---------- 审计日志 ----------

// 管理动作审计（data/audit.jsonl 单行 JSON）。detail 只放非敏感摘要，
// 绝不含密码明文/哈希或 token。
export const AUDIT_ACTIONS = [
  "user.role_change",
  "user.disable",
  "user.enable",
  "user.reset_password",
  "user.kick",
  "review.approve",
  "review.reject",
  // 全局 MCP 服务器配置变更（管理员）。
  "mcp.global_save",
  "mcp.global_delete",
  // 全局专家技能变更（管理员）。
  "skills.global_save",
  "skills.global_delete",
] as const;

export const AuditEntry = z.object({
  ts: z.string(), // ISO 时间戳
  actor: z.string(), // 操作者用户名
  action: z.enum(AUDIT_ACTIONS),
  target: z.string(), // 受影响用户名（或 "-"）
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditLogResponse = z.object({ entries: z.array(AuditEntry) });
export type AuditLogResponse = z.infer<typeof AuditLogResponse>;
