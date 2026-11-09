import { z } from "zod";
import { WorkflowName, WorkflowStage } from "./workflows.js";

// ---------- 团队协作流（可自定义工作流模板） ----------

// v2 状态机：active（在途，环节位置由 current_stage 表达）| done（完结）。
export const TaskStatus = z.enum(["active", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// v2 流转动作：推进 / 打回到之前环节 / 指派换人 / 取消。
export const FlowAction = z.enum(["advance", "send_back", "assign", "cancel"]);
export type FlowAction = z.infer<typeof FlowAction>;

// 旧版枚举仅存留供桌面端渲染历史 flow_event 块（历史块不改写）。
export const LegacyTaskStatus = z.enum(["analyzing", "developing", "fixing", "testing", "done"]);
export type LegacyTaskStatus = z.infer<typeof LegacyTaskStatus>;
export const LegacyFlowAction = z.enum([
  "assign_dev",
  "submit_test",
  "assign_tester",
  "report_issue",
  "resubmit",
  "pass",
  "cancel",
]);
export type LegacyFlowAction = z.infer<typeof LegacyFlowAction>;

// 任务视图（REST 列表 + WS 推送共用）。stages 是建任务时的环节快照（含各环节
// 负责人），此后随模板编辑不变；current_stage 为环节 key，null = 已完结。
// target 用户均为注册用户名。
export const TaskView = z.object({
  task_id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: TaskStatus,
  cancelled: z.boolean().optional(), // done 且为取消（迁移来的旧 done 不带）
  // 承载任务讨论的会话（需求方所有；协作者经共享可见）。
  session_id: z.string(),
  requester: z.string(), // 需求方
  template_name: z.string(), // 建任务所用模板名（仅展示用，运行不依赖）
  stages: z.array(WorkflowStage).min(1), // 环节快照（负责人即 assignee）
  current_stage: z.string().nullable(), // 环节 key；null = 已完结
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskView = z.infer<typeof TaskView>;

// REST: 由需求方创建任务线程（同时建一个绑定会话）。template_name 缺省 =
// 内置「标准流程」；assignees = 显式指派（stage_key → 用户名，空串 = 清空预置
// 岗位），未提到的环节用模板预置。
export const CreateTaskRequest = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(8000).optional(),
  agent_id: z.string().optional(), // 缺省 "assistant"
  template_name: WorkflowName.optional(),
  assignees: z.record(z.string(), z.string()).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

// REST: 推进任务流转。target = assign 的目标用户名；stage_key = send_back/assign
// 的目标环节 key；note = 说明（可选，进时间线）。
export const TaskFlowRequest = z.object({
  action: FlowAction,
  target: z.string().max(64).optional(),
  stage_key: z.string().max(64).optional(),
  note: z.string().max(2000).optional(),
});
export type TaskFlowRequest = z.infer<typeof TaskFlowRequest>;

export const TasksResponse = z.object({
  tasks: z.array(TaskView),
});
export type TasksResponse = z.infer<typeof TasksResponse>;
