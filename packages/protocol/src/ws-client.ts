import { z } from "zod";

// ---------- Client -> Server (WebSocket) ----------

export const WsUserMessage = z.object({
  type: z.literal("user_message"),
  session_id: z.string(),
  text: z.string().min(1),
});

export const WsInterrupt = z.object({
  type: z.literal("interrupt"),
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
  WsPermissionResponse,
  WsToolExecResult,
  WsPing,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
