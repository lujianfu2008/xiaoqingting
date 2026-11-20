import { z } from "zod";

// ---------- 网络中继 V2：消息级 LLM 桥 ----------
//
// 服务端网络够不到部分大模型 API 时，借用户桌面端的网络：引擎的
// ANTHROPIC_BASE_URL 指向服务端上「每用户一个」的本地桥端口（明文 HTTP），
// 桥把引擎的 LLM API 请求（方法/路径/头/体）作为 WS 消息发给桌面端，桌面
// 用本机网络发起真实请求，把响应状态/SSE 分片作为消息流式回传给桥，桥原样
// 写回引擎。隧道消息只出现在 /ws/relay 通道，用这里的独立 union，不进聊天
// 通道的 ServerMessage/ClientMessage。
//
// mcp_request 复用同一通道与回帧族：用户级 MCP 服务器（「我的」）的
// 实际连接由会话主人的桌面发起（本机 http/sse 直接转发、stdio 桌面
// spawn），服务端只存配置不代连。
//
// 请求体与 SSE 都是文本——全程纯文本 JSON，无 base64、无字节分块、无背压
// 轮询；上游响应若声明 gzip 等压缩编码会破坏文本性，服务端转发时剔除
// accept-encoding（见 llmBridge）。

const ReqId = z.string().regex(/^[0-9a-f]{16}$/); // crypto.randomBytes(8).hex，服务端生成

/** 服务端 → 桌面：代发一个 LLM API 请求。url 为完整目标（真实 base_url + 引擎路径）；headers 已剔除 hop-by-hop，含认证头。 */
export const LlmRequest = z.object({
  type: z.literal("llm_request"),
  req_id: ReqId,
  method: z.enum(["GET", "POST", "HEAD"]),
  url: z.string().url().max(2000),
  headers: z.record(z.string(), z.string().max(4000)),
  body: z.string().max(32 * 1024 * 1024).optional(),
});
export type LlmRequest = z.infer<typeof LlmRequest>;

/** 桌面 spawn 一个用户级 stdio MCP 服务器的启动参数（command/args/env
 * 只经这条帧从服务端到桌面，绝不进引擎面）。 */
export const McpSpawn = z.object({
  command: z.string().min(1).max(2048),
  args: z.array(z.string().max(2048)).max(64).optional(),
  env: z.record(z.string(), z.string().max(8000)).optional(),
});
export type McpSpawn = z.infer<typeof McpSpawn>;

/** 服务端 → 桌面：代发一条 MCP 请求（用户级 MCP 隧道）。
 * - 无 spawn：http/sse 远程服务器，url 为真实目标，桌面照 LLM 中继
 *   原样转发（响应头带 Mcp-Session-Id 等，需透传）。
 * - 有 spawn：stdio 服务器，桌面 spawn 子进程、按 newline-delimited
 *   JSON-RPC 走 stdin/stdout（name 用于进程复用，url 省略）。
 */
export const McpRequest = z
  .object({
    type: z.literal("mcp_request"),
    req_id: ReqId,
    method: z.enum(["GET", "POST", "DELETE"]),
    /** MCP 服务器名（进程复用键 + 日志）。 */
    name: z.string().max(64),
    url: z.string().max(2048).optional(),
    headers: z.record(z.string(), z.string().max(4000)).optional(),
    body: z.string().max(32 * 1024 * 1024).optional(),
    spawn: McpSpawn.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.spawn && v.url) {
      ctx.addIssue({ code: "custom", message: "stdio 隧道请求不应携带 url" });
    }
    if (!v.spawn && !v.url?.trim()) {
      ctx.addIssue({ code: "custom", message: "远程隧道请求需要 url" });
    }
  });
export type McpRequest = z.infer<typeof McpRequest>;

/** 服务端 → 桌面：引擎侧中断（用户点停止/请求断开），桌面 abort 对应请求。 */
export const LlmCancel = z.object({
  type: z.literal("llm_cancel"),
  req_id: ReqId,
});
export type LlmCancel = z.infer<typeof LlmCancel>;

/** 桌面 → 服务端：响应状态与内容类型（分片之前发一次）。headers 透传
 * 响应头（MCP 需要 Mcp-Session-Id 等；LLM 路径不传，向后兼容）。 */
export const LlmResponseHead = z.object({
  type: z.literal("llm_response_head"),
  req_id: ReqId,
  status: z.number().int().min(100).max(599),
  content_type: z.string().max(300).optional(),
  headers: z.record(z.string(), z.string().max(4000)).optional(),
});
export type LlmResponseHead = z.infer<typeof LlmResponseHead>;

/** 桌面 → 服务端：响应体文本分片（SSE 事件流天然小块）。 */
export const LlmResponseChunk = z.object({
  type: z.literal("llm_response_chunk"),
  req_id: ReqId,
  data: z.string().max(1024 * 1024),
});
export type LlmResponseChunk = z.infer<typeof LlmResponseChunk>;

/** 桌面 → 服务端：请求结束。error 缺省 = 正常结束；有值 = 桌面侧失败原因。 */
export const LlmResponseEnd = z.object({
  type: z.literal("llm_response_end"),
  req_id: ReqId,
  error: z.string().max(300).optional(),
});
export type LlmResponseEnd = z.infer<typeof LlmResponseEnd>;

export const RelayServerMessage = z.discriminatedUnion("type", [
  LlmRequest,
  LlmCancel,
  McpRequest,
]);
export type RelayServerMessage = z.infer<typeof RelayServerMessage>;

export const RelayClientMessage = z.discriminatedUnion("type", [
  LlmResponseHead,
  LlmResponseChunk,
  LlmResponseEnd,
]);
export type RelayClientMessage = z.infer<typeof RelayClientMessage>;

// ---------- REST：中继配置与状态 ----------

/** 服务端内存统计（不落盘）。 */
export const RelayStats = z.object({
  requests_total: z.number().int(),
  requests_failed: z.number().int(),
  /** 当前 relay WS 在线的用户名（桥可用）。 */
  bridge_online_users: z.array(z.string()),
  last_request: z
    .object({
      username: z.string(),
      host: z.string(),
      at: z.string(),
      ok: z.boolean(),
    })
    .optional(),
  last_error: z.string().optional(),
});
export type RelayStats = z.infer<typeof RelayStats>;

/** 管理员总开关（data/relay.json）。默认 enabled=false = 功能关闭（fail-closed）。 */
export const RelayConfigUpdate = z.object({
  enabled: z.boolean(),
});
export type RelayConfigUpdate = z.infer<typeof RelayConfigUpdate>;

export const RelayConfigInfo = z.object({
  enabled: z.boolean(),
  updated_at: z.string().optional(),
  stats: RelayStats,
});
export type RelayConfigInfo = z.infer<typeof RelayConfigInfo>;

/** 用户侧状态：我的开关 + 管理员总开关 + 我的桌面端是否在线可中继。 */
export const MyRelayStatus = z.object({
  opt_in: z.boolean(),
  master_enabled: z.boolean(),
  relay_online: z.boolean(),
});
export type MyRelayStatus = z.infer<typeof MyRelayStatus>;
