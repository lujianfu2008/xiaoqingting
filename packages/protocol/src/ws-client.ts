import { z } from "zod";

// ---------- Client -> Server (WebSocket) ----------

export const WsUserMessage = z.object({
  type: z.literal("user_message"),
  session_id: z.string(),
  text: z.string().min(1),
  // 客户端生成的送达确认 id：服务端原样回显在 user_text 块上，发送方据此
  // 解除自己那一条的 ack（回合进行中连发补充消息时不会互相覆盖）。
  client_msg_id: z.string().optional(),
});

export const WsInterrupt = z.object({
  type: z.literal("interrupt"),
  session_id: z.string(),
});

// 重新生成：对会话里最后一条用户消息再跑一轮回复。不带文本——
// 服务端从已落库历史里取原文重发（不追加新 user_text 块，历史
// 不重复）；会话没有用户消息时服务端拒绝。
export const WsRegenerate = z.object({
  type: z.literal("regenerate"),
  session_id: z.string(),
});

export const WsPermissionResponse = z.object({
  type: z.literal("permission_response"),
  request_id: z.string(),
  allow: z.boolean(),
});

// Base64 image bytes produced by read_attachment (image mode); the server
// forwards them into the engine's tool result as MCP image blocks.
export const AttachmentImage = z.object({
  media_type: z.string(),
  data: z.string(),
});
export type AttachmentImage = z.infer<typeof AttachmentImage>;

export const WsToolExecResult = z.object({
  type: z.literal("tool_exec_result"),
  request_id: z.string(),
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  images: z.array(AttachmentImage).optional(),
});

export const WsPing = z.object({ type: z.literal("ping") });

export const ClientMessage = z.discriminatedUnion("type", [
  WsUserMessage,
  WsInterrupt,
  WsRegenerate,
  WsPermissionResponse,
  WsToolExecResult,
  WsPing,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
