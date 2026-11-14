import { z } from "zod";

// ---------- Session / agent metadata ----------

// Token usage for one turn / accumulated for a session. cost_usd is null
// unless the server runs with REVEAL_USAGE=true.
export const Usage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number().nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const SessionMeta = z.object({
  session_id: z.string(),
  title: z.string(),
  agent_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  // Project grouping: null/absent = the default space (legacy sessions).
  project_id: z.string().nullable().optional(),
  // Knowledge sharing: session owner can mark a session shared (read-only for others).
  shared: z.boolean().optional(),
  // Empty/absent = shared with everyone; otherwise only these usernames.
  shared_with: z.array(z.string()).optional(),
  // 可代为确认审批的成员（并行字段，不改 shared_with 结构）：这些共享对象
  // 在线时会同时收到 permission_request，谁先应答谁生效（后到的应答为 no-op）。
  // 本机执行（tool_exec）始终仅限会话主人。空/缺省 = 只有主人可审批。
  approvers: z.array(z.string()).optional(),
  // Present in shared-session listings: username of the owner.
  owner: z.string().optional(),
  // Present in shared-session listings: whether the owner currently has a
  // live WS connection (they are the only one who can approve local actions).
  owner_online: z.boolean().optional(),
  // Accumulated token usage over the whole session (server-side bookkeeping).
  usage: Usage.optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

export const AgentInfo = z.object({
  agent_id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

// ---------- Project (a named space grouping sessions) ----------

export const ProjectMeta = z.object({
  project_id: z.string(),
  name: z.string(),
  agent_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  // 个人项目（缺省 = personal，兼容旧数据）或公有域项目（文件存放在服务端工作空间，全员可读）。
  visibility: z.enum(["personal", "public"]).optional(),
  // 公有域项目必有：创建者（管理员）用户名；个人项目即创建者本人。
  owner: z.string().optional(),
  // 空间说明（可选）：这个工作空间是干什么的；随会话注入智能体上下文。
  description: z.string().optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;
