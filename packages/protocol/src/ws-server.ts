import { z } from "zod";
import { Block } from "./blocks.js";
import { SessionMeta } from "./sessions.js";
import { UpdateRequestView } from "./public.js";

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
    "choose_workdir",
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_close",
  ]),
  params: z.record(z.string(), z.unknown()),
});
export type WsToolExecRequest = z.infer<typeof WsToolExecRequest>;

export const WsResult = z.object({
  type: z.literal("result"),
  session_id: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
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
  WsUpdateRequest,
  WsUpdateRequestDecided,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
