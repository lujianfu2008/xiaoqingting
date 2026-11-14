import { z } from "zod";
import { Block } from "./blocks.js";
import { SessionMeta, Usage } from "./sessions.js";
import { UpdateRequestView } from "./public.js";
import { TaskView } from "./tasks.js";
import { WsScheduleUpdate } from "./schedules.js";

// ---------- Server -> Client (WebSocket) ----------

export const WsMessageDelta = z.object({
  type: z.literal("message_delta"),
  session_id: z.string(),
  delta: z.string(),
});

export const WsMessageBlock = z.object({
  type: z.literal("message_block"),
  session_id: z.string(),
  block: Block,
});

export const WsPermissionRequest = z.object({
  type: z.literal("permission_request"),
  request_id: z.string(),
  session_id: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
  // 请求来源是子代理时带上（客户端弹窗标注「子代理 xx 请求使用 …」）
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
});
export type WsPermissionRequest = z.infer<typeof WsPermissionRequest>;

// Server asks the client to perform a local action on the user's machine.
export const WsToolExecRequest = z.object({
  type: z.literal("tool_exec_request"),
  request_id: z.string(),
  session_id: z.string(),
  action: z.enum([
    "run_command",
    "read_file",
    "write_file",
    "list_dir",
    "get_workdir",
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_close",
  ]),
  params: z.record(z.string(), z.unknown()),
  agent_id: z.string().optional(), // 同 WsPermissionRequest
  agent_name: z.string().optional(),
});
export type WsToolExecRequest = z.infer<typeof WsToolExecRequest>;

export const WsResult = z.object({
  type: z.literal("result"),
  session_id: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  // Per-turn token usage; cost_usd is null unless the server has
  // REVEAL_USAGE=true. Tokens are always reported.
  usage: Usage.optional(),
  // 引擎命令队列里还剩几条用户消息（含回合中被并入的补充消息）。>0 表示
  // 不用再输入就会继续有回复；客户端据此保持 busy，而不是看到第一个 result
  // 就把输入解锁（否则补充消息的回复还在路上，界面已显示空闲）。
  queued_turn_count: z.number().optional(),
});

export const WsError = z.object({
  type: z.literal("error"),
  session_id: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export const WsSessionCreated = z.object({
  type: z.literal("session_created"),
  session: SessionMeta,
});

export const WsPong = z.object({ type: z.literal("pong") });

// 服务端权威的回合忙闲状态：忙闲翻转时推给主人与共享可见用户，
// 连接建立时对在跑会话补推。共享会话的引擎由别人驱动时，协作者
// 据此显示忙碌（数字人思考/侧栏橙点）——引擎忙不忙只有服务端知道。
export const WsTurnState = z.object({
  type: z.literal("turn_state"),
  session_id: z.string(),
  busy: z.boolean(),
});
export type WsTurnState = z.infer<typeof WsTurnState>;

// Someone came online / went offline — drives the presence dots in the
// shared-session list and the share-target picker.
export const WsPresence = z.object({
  type: z.literal("presence"),
  user_id: z.string(),
  online: z.boolean(),
});

// 公有域更新申请：提交时推给在线管理员；决定后推给申请人与管理员。
export const WsUpdateRequest = z.object({
  type: z.literal("update_request"),
  request: UpdateRequestView,
});
export type WsUpdateRequest = z.infer<typeof WsUpdateRequest>;

export const WsUpdateRequestDecided = z.object({
  type: z.literal("update_request_decided"),
  request: UpdateRequestView,
});
export type WsUpdateRequestDecided = z.infer<typeof WsUpdateRequestDecided>;

// 注册审核：新用户注册时推给在线管理员/审核员；连接建立时补推当前待审数量。
export const WsReviewRequest = z.object({
  type: z.literal("review_request"),
  pending: z.number(),
});
export type WsReviewRequest = z.infer<typeof WsReviewRequest>;

// 协作流任务变更：推给任务相关人（需求方/研发/测试），连接建立时补推活跃任务。
export const WsTaskUpdate = z.object({
  type: z.literal("task_update"),
  task: TaskView,
});
export type WsTaskUpdate = z.infer<typeof WsTaskUpdate>;

// 任务记录删除：推给任务相关人，客户端摘除列表条目。
export const WsTaskGone = z.object({
  type: z.literal("task_gone"),
  task_id: z.string(),
});
export type WsTaskGone = z.infer<typeof WsTaskGone>;

// 定时任务变更（定义在 schedules.js，经 index.ts 桶导出）：推给任务主人，
// 连接建立后靠 REST 播种收敛，与 task_update 同构。

export const ServerMessage = z.discriminatedUnion("type", [
  WsMessageDelta,
  WsMessageBlock,
  WsPermissionRequest,
  WsToolExecRequest,
  WsResult,
  WsError,
  WsSessionCreated,
  WsPresence,
  WsPong,
  WsTurnState,
  WsUpdateRequest,
  WsUpdateRequestDecided,
  WsReviewRequest,
  WsTaskUpdate,
  WsTaskGone,
  WsScheduleUpdate,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
