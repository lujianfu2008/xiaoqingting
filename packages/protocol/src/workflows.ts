import { z } from "zod";

// ---------- 可自定义协作工作流（模板两层：内置 < 全局 < 用户同名覆盖） ----------

// 环节定义（模板与任务快照共用同一形状）。key 是稳定标识（建环节时生成，
// 改名不变），assignee 是预置负责人（岗位），建任务时带出、可换可空。
export const WorkflowStage = z.object({
  key: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  assignee: z.string().trim().min(1).max(64).optional(),
});
export type WorkflowStage = z.infer<typeof WorkflowStage>;

// 内置默认模板名（不可删改；运行时常量合并，不落盘）。
export const BUILT_IN_WORKFLOW_NAME = "标准流程";

// 模板名即主键（两层级共用命名空间，同名个人覆盖全局，与 MCP 同构）。
export const WorkflowName = z.string().trim().min(1).max(60);

// REST: 新建/更新模板（name 在路径上，故不含 name）。
export const UpsertWorkflowRequest = z.object({
  description: z.string().max(500).optional(),
  stages: z.array(WorkflowStage).min(1).max(12),
});
export type UpsertWorkflowRequest = z.infer<typeof UpsertWorkflowRequest>;

// 模板客户端视图（合并后，带来源标记；照 McpServerInfo 模式）。
export const WorkflowInfo = z.object({
  name: WorkflowName,
  description: z.string().optional(),
  stages: z.array(WorkflowStage),
  source: z.enum(["built_in", "global", "user"]),
  overrides_global: z.boolean().optional(), // 我的同名覆盖了全局
  updated_at: z.string().optional(),
});
export type WorkflowInfo = z.infer<typeof WorkflowInfo>;

export const WorkflowsResponse = z.object({ workflows: z.array(WorkflowInfo) });
export type WorkflowsResponse = z.infer<typeof WorkflowsResponse>;
