import { z } from "zod";

// ---------- 公有域项目（共有知识库）：更新申请 ----------

export const UpdateRequestStatus = z.enum(["pending", "approved", "rejected"]);
export type UpdateRequestStatus = z.infer<typeof UpdateRequestStatus>;

// 申请视图（WS 推送 / 列表用）：不携带全文，preview 为内容截断预览。
export const UpdateRequestView = z.object({
  request_id: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  session_id: z.string(),
  // 申请人（username）。
  requester: z.string(),
  // 工作空间内的逻辑路径（绝不暴露服务器绝对路径）。
  path: z.string(),
  preview: z.string(),
  status: UpdateRequestStatus,
  created_at: z.string(),
  decided_at: z.string().optional(),
  decided_by: z.string().optional(),
  reason: z.string().optional(),
});
export type UpdateRequestView = z.infer<typeof UpdateRequestView>;

export const UpdateRequestsResponse = z.object({
  requests: z.array(UpdateRequestView),
});
export type UpdateRequestsResponse = z.infer<typeof UpdateRequestsResponse>;

// 管理员详情：附待写入全文。
export const UpdateRequestDetail = UpdateRequestView.extend({
  content: z.string(),
});
export type UpdateRequestDetail = z.infer<typeof UpdateRequestDetail>;

// REST: 管理员批准/拒绝一条更新申请。
export const DecideUpdateRequest = z.object({
  approve: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type DecideUpdateRequest = z.infer<typeof DecideUpdateRequest>;
