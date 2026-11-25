import { z } from "zod";
import { Block } from "./blocks.js";
import { ProjectKind, ProjectWorkflow, SessionMeta } from "./sessions.js";
import { DiagLayout } from "./diag.js";
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
  // 项目类型（缺省 standard）；collab/scheduled 仅允许个人项目。
  kind: ProjectKind.optional(),
  // 协作项目的环节序列（仅 kind === "collab" 时收下）。
  workflow: ProjectWorkflow.optional(),
  // 空间说明（可选）：随会话注入智能体上下文。
  description: z.string().trim().max(500).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// REST: update a collab project's stage chain (owner only).
export const UpdateProjectWorkflowRequest = ProjectWorkflow;
export type UpdateProjectWorkflowRequest = z.infer<typeof UpdateProjectWorkflowRequest>;

// REST: update a project space's description (owner only; empty = clear).
export const SetProjectDescriptionRequest = z.object({
  description: z.string().trim().max(500),
});
export type SetProjectDescriptionRequest = z.infer<typeof SetProjectDescriptionRequest>;

// REST: toggle sharing of one of my sessions (owner only).
export const ShareSessionRequest = z.object({
  shared: z.boolean(),
  shared_with: z.array(z.string()).optional(),
  // 可代为确认审批的成员（须同时是共享可见用户；见 SessionMeta.approvers）。
  approvers: z.array(z.string()).optional(),
});
export type ShareSessionRequest = z.infer<typeof ShareSessionRequest>;

export const SessionHistory = z.object({
  session: SessionMeta,
  blocks: z.array(Block),
});
export type SessionHistory = z.infer<typeof SessionHistory>;

// ---------- 会话内容搜索（GET /api/sessions/search） ----------

// q 至少 1 字符（中文 1 字即搜，英文也放行——门槛由客户端防抖兜底）；
// limit = 最多返回的会话数。
export const SessionSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SessionSearchQuery = z.infer<typeof SessionSearchQuery>;

// 单条命中：block_index = 块在会话历史里的下标（与 /messages 返回的
// blocks 数组对齐）；snippet 由服务端截好（命中词前后各 ~60 字），
// 命中词以 ** 包裹供客户端高亮；块历史不落时间戳，created_at 以
// 会话最近更新时间作参考。
export const SessionSearchMatch = z.object({
  block_index: z.number().int().nonnegative(),
  snippet: z.string(),
  created_at: z.string(),
});
export type SessionSearchMatch = z.infer<typeof SessionSearchMatch>;

export const SessionSearchItem = z.object({
  session_id: z.string(),
  session_title: z.string(),
  project_id: z.string().nullable(),
  // 每会话最多展示 3 条命中。
  matches: z.array(SessionSearchMatch).max(3),
  // 该会话命中块总数（未截断）。
  total: z.number().int().nonnegative(),
});
export type SessionSearchItem = z.infer<typeof SessionSearchItem>;

export const SessionSearchResponse = z.array(SessionSearchItem);
export type SessionSearchResponse = z.infer<typeof SessionSearchResponse>;

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
  // 是否已授权在公有域会话执行服务端命令（run_command）。
  public_exec: z.boolean().optional(),
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

// 单条审计日志删除：按 时间戳+操作者+动作 三元组定位（JSONL 无行号指针）。
// target 可能含特殊字符，不能入路径，只做内容匹配。
export const AuditDeleteRequest = z.object({
  ts: z.string(),
  actor: z.string().min(1),
  action: z.string().min(1),
});
export type AuditDeleteRequest = z.infer<typeof AuditDeleteRequest>;

// 公有域服务端执行授权开关（仅管理员）。
export const PublicExecToggleRequest = z.object({ enabled: z.boolean() });
export type PublicExecToggleRequest = z.infer<typeof PublicExecToggleRequest>;

// ---------- 显示诊断（仅管理员） ----------

// 发起一次诊断采集：目标用户须在线（WS 推送）。scope=screenshot
// 时客户端会附整窗截图（含聊天内容），管理页发起处有明示。
export const DiagCollectRequest = z.object({
  scope: z.enum(["layout", "screenshot"]),
});
export type DiagCollectRequest = z.infer<typeof DiagCollectRequest>;

// 诊断结果清单（管理页「诊断」tab）：只回元数据，
// 截图/摘要全文按 id 另取。
export const DiagEntryMeta = z.object({
  id: z.string(),
  username: z.string(),
  scope: z.enum(["layout", "screenshot"]),
  at: z.string(),
  has_screenshot: z.boolean(),
});
export type DiagEntryMeta = z.infer<typeof DiagEntryMeta>;

export const DiagListResponse = z.object({ entries: z.array(DiagEntryMeta).max(50) });
export type DiagListResponse = z.infer<typeof DiagListResponse>;

export const DiagDetailResponse = z.object({
  layout: DiagLayout.nullable(),
  screenshot: z.object({ media_type: z.string(), data: z.string() }).nullable(),
});
export type DiagDetailResponse = z.infer<typeof DiagDetailResponse>;


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
  // 删除用户账号（管理动作，留下痕迹供回溯）。
  "user.delete",
  "review.approve",
  "review.reject",
  // 全局 MCP 服务器配置变更（管理员）。
  "mcp.global_save",
  "mcp.global_delete",
  // 全局专家技能变更（管理员）。
  "skills.global_save",
  "skills.global_delete",
  "skills.global_toggle",
  // 客户端出口中继配置变更（管理员）。
  "relay.config_save",
  // 远程诊断任务（管理员借用在线客户端的智能体排障）。
  "diag.task_start",
  // 全局工作流模板变更（管理员）。
  "workflow.global_save",
  "workflow.global_delete",
  // 公有域服务端执行授权变更（管理员）。
  "public.exec_auth_change",
  // 显示诊断采集（管理员发起，客户端自愿回传）。
  "diag.collect",
  // 用户侧会话动作（多用户可见度操作，出问题可回溯）。
  // target = session_id；detail 带 owner/shared_with 摘要，绝不含密码。
  "session.share",
  "session.unshare",
  "session.delete",
  "session.rename",
  "session.export",
  // 审计日志删除（单条或清空，仅管理员）。
  "audit.delete",
  "audit.clear",
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

// ---------- 共享会话附件（跨机可见） ----------

// 共享会话/协作线程里粘贴的附件上传到服务端托管：消息里的 [附件] 行改带
// `att:<sessionId>/<id>` 引用，协作者查看与引擎 read_attachment 都按引用
// 从服务端取回。单文件上限与桌面 read_attachment 的 10MB 对齐（base64
// 后约 13.7MB，路由 bodyLimit 放到 20MB）。
export const AttachmentUploadRequest = z.object({
  name: z.string().min(1).max(200),
  data: z
    .string()
    .regex(/^[A-Za-z0-9+/=]+$/, "附件数据必须是 base64")
    .max(16_000_000), // 12MB base64 ≈ 9MB 原文，留出余量
});
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequest>;

export const AttachmentUploadResponse = z.object({
  ok: z.literal(true),
  id: z.string(),
  name: z.string(),
});
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponse>;
