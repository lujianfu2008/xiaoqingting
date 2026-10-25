import { z } from "zod";
import { Block } from "./blocks.js";
import { SessionMeta } from "./sessions.js";
// ---------- REST ----------

// 用户角色：admin = 公有域管理员（可创建公域项目、审批更新申请、管理用户）。
export const Role = z.enum(["admin", "user"]);
export type Role = z.infer<typeof Role>;

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
