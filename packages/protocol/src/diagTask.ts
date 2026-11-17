import { z } from "zod";

// ---------- 远程诊断任务（管理员借用客户端智能体排障） ----------

// 动机：显示脱节一类问题只有用户机器上才能观察。已有 layout/screenshot
// 采集只拿「静态原料」；本机制更进一步——把一个调试任务交给目标用户
// 在线的客户端智能体（该用户的 LLM + 该用户本机的工具面），让它在
// 用户机器上执行只读探查（读布局配置、跑诊断命令、描述现场），最终
// 报告落回服务端存档，供管理员（或服务端侧的运维智能体）分析。

/** 任务模板枚举：服务端按模板生成提示词（管理员不写提示词，防滥用）。 */
export const DiagTaskKind = z.enum(["display_layout"]);
export type DiagTaskKind = z.infer<typeof DiagTaskKind>;

export const DiagTaskStartRequest = z.object({
  kind: DiagTaskKind,
});
export type DiagTaskStartRequest = z.infer<typeof DiagTaskStartRequest>;

/** 发起成功 = 会话已建 + 提示词已喂。报告异步落存档。 */
export const DiagTaskStartResponse = z.object({
  task_id: z.string(),
  session_id: z.string(),
});
export type DiagTaskStartResponse = z.infer<typeof DiagTaskStartResponse>;

export const DiagTaskEntry = z.object({
  task_id: z.string(),
  username: z.string(),
  session_id: z.string(),
  kind: DiagTaskKind,
  // running | done | error | timeout
  status: z.enum(["running", "done", "error", "timeout"]),
  at: z.string(),
  finished_at: z.string().optional(),
  // 结束原因（error/timeout 时的人话描述）。
  note: z.string().optional(),
});
export type DiagTaskEntry = z.infer<typeof DiagTaskEntry>;

export const DiagTaskListResponse = z.object({
  entries: z.array(DiagTaskEntry),
});
export type DiagTaskListResponse = z.infer<typeof DiagTaskListResponse>;

export const DiagTaskDetailResponse = z.object({
  entry: DiagTaskEntry,
  // 最终报告全文（done 才有）；error/timeout 时是现场摘要。
  report: z.string().nullable(),
});
export type DiagTaskDetailResponse = z.infer<typeof DiagTaskDetailResponse>;
