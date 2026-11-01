import { z } from "zod";

// ---------- 团队协作流（需求 → 研发 → 测试） ----------

// 任务线程的状态机：需求分析 → 开发 → （测试发现问题）修复 → 测试 → 通过。
export const TaskStatus = z.enum(["analyzing", "developing", "fixing", "testing", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// 流转动作：指派研发 / 提测 / 改派测试 / 报问题 / 重新提测 / 通过。
export const FlowAction = z.enum([
  "assign_dev",
  "submit_test",
  "assign_tester",
  "report_issue",
  "resubmit",
  "pass",
]);
export type FlowAction = z.infer<typeof FlowAction>;

// 任务视图（REST 列表 + WS 推送共用）。target 用户均为注册用户名。
export const TaskView = z.object({
  task_id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: TaskStatus,
  // 承载任务讨论的会话（需求方所有；协作者经共享可见）。
  session_id: z.string(),
  requester: z.string(), // 需求方
  dev: z.string().optional(), // 当前研发
  tester: z.string().optional(), // 当前测试
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskView = z.infer<typeof TaskView>;

// REST: 由需求方创建任务线程（同时建一个绑定会话）。
export const CreateTaskRequest = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(8000).optional(),
  agent_id: z.string().optional(), // 缺省 "assistant"
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

// REST: 推进任务流转。target = 动作对象用户名（assign_dev/assign_tester 必填，
// submit_test 可选预先指定测试）；note = 说明（report_issue 必填）。
export const TaskFlowRequest = z.object({
  action: FlowAction,
  target: z.string().optional(),
  note: z.string().max(2000).optional(),
});
export type TaskFlowRequest = z.infer<typeof TaskFlowRequest>;

export const TasksResponse = z.object({
  tasks: z.array(TaskView),
});
export type TasksResponse = z.infer<typeof TasksResponse>;
