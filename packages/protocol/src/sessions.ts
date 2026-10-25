import { z } from "zod";

// ---------- Session / agent metadata ----------

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
  // Present in shared-session listings: username of the owner.
  owner: z.string().optional(),
  // Present in shared-session listings: whether the owner currently has a
  // live WS connection (they are the only one who can approve local actions).
  owner_online: z.boolean().optional(),
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
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;
