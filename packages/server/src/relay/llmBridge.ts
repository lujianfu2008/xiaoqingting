import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayClientMessage } from "@blm/protocol";
import { getUserLlmConfig } from "../llmConfig.js";
import { getRelayOptIn, loadRelayConfig } from "./relayConfig.js";
import { relayRegistry } from "./registry.js";

// 网络中继 V2：消息级 LLM 桥。
// 引擎 env 的 ANTHROPIC_BASE_URL 指向「每用户一个」的本地桥端口（127.0.0.1
// 随机端口——引擎请求不带凭证，端口即用户身份）。桥把引擎的 LLM API 请求
// 包装成 llm_request 消息经 /ws/relay 发给桌面端，桌面用本机网络发起真实
// 请求并把 SSE 分片流式回传，桥原样写回引擎。
//
// 对引擎而言这只是一个普通的 HTTP 端点：桌面离线 → 503 JSON（SDK 当普通
// API 错误，走既有 agent_error 路径，桌面重连后下一条消息自动恢复）。

const BODY_MAX = 32 * 1024 * 1024; // 长上下文请求体上限
const REQ_CONCURRENCY_MAX = 8; // 每用户同时在桥上的 LLM 请求数
const REQ_IDLE_TIMEOUT_MS = 300_000; // 单请求无数据超时（流式响应每片续期）

// hop-by-hop 与会破坏文本性/寻址的头不转发（accept-encoding 剔除防压缩响应）。
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "accept-encoding",
]);

interface BridgeServer {
  server: http.Server;
  port: number;
  pending: Map<string, PendingRequest>;
}

interface PendingRequest {
  res: ServerResponse;
  host: string;
  headersSent: boolean;
  idleTimer: NodeJS.Timeout;
}

const bridges = new Map<string, BridgeServer>();

/**
 * 会话启动时计算引擎 env 的中继注入（sessionOptions.ts 消费）。
 * 返回 null = 不注入，引擎直连（中继关、未 opt-in 或桥未就绪——行为与
 * 功能不存在时完全一致）。同步函数：桥端口在 opt-in/开关翻转/启动时预建。
 */
export function relayEnvFor(userId: string): { port: number } | null {
  if (!loadRelayConfig().enabled) return null;
  if (!getRelayOptIn(userId)) return null;
  const bridge = bridges.get(userId);
  if (!bridge) return null;
  return { port: bridge.port };
}

/** 引擎请求的真实目标（与 sessionOptions 的 env 逻辑同源）：个人 base_url ‖ 全局 env ‖ 官方默认。 */
function resolveBaseUrl(userId: string): string {
  const personal = getUserLlmConfig(userId)?.base_url?.trim();
  return (
    (personal || process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    )
  );
}

/** 确保某用户的桥端口已监听（幂等）。REST opt-in / 管理开关翻转 / 启动时调用。 */
export function ensureBridge(username: string): Promise<number> {
  const existing = bridges.get(username);
  if (existing) return Promise.resolve(existing.port);
  return new Promise((resolve, reject) => {
    const pending = new Map<string, PendingRequest>();
    const server = http.createServer((req, res) => {
      void handleBridgeRequest(username, req, res, pending);
    });
    server.on("clientError", (_err, sock) => sock.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      bridges.set(username, { server, port, pending });
      console.info(`[relay] LLM 桥已就绪 user=${username} port=${port}`);
      resolve(port);
    });
  });
}

/** 关闭某用户的桥端口（opt-out / 总开关关闭时调用；在途请求直接断，引擎走错误路径）。 */
export function closeBridge(username: string): void {
  const bridge = bridges.get(username);
  if (!bridge) return;
  bridges.delete(username);
  for (const pending of bridge.pending.values()) {
    clearTimeout(pending.idleTimer);
    failJson(pending.res, 502, "中继已关闭");
  }
  bridge.pending.clear();
  bridge.server.close(() => undefined);
}

/** 服务启动时为已有 opt-in 用户预建桥（fail-silent：起不来仅禁用该用户中继）。 */
export async function ensureBridgesAtStartup(optInUsernames: string[]): Promise<void> {
  for (const username of optInUsernames) {
    if (!loadRelayConfig().enabled) break;
    try {
      await ensureBridge(username);
    } catch (err) {
      console.error(`[relay] LLM 桥启动失败 user=${username}:`, err);
    }
  }
}

// ---------- 引擎请求入口 ----------

async function handleBridgeRequest(
  username: string,
  req: IncomingMessage,
  res: ServerResponse,
  pending: Map<string, PendingRequest>,
): Promise<void> {
  // 读完整请求体（LLM API 请求都是 JSON 文本）。
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) {
      tooLarge = true;
      break;
    }
    chunks.push(c as Buffer);
  }
  if (tooLarge) {
    failJson(res, 413, "请求体过大");
    return;
  }
  const body = Buffer.concat(chunks).toString("utf8");

  if (pending.size >= REQ_CONCURRENCY_MAX) {
    failJson(res, 429, "中继请求并发已达上限");
    return;
  }
  if (!relayRegistry.isRelayOnline(username)) {
    relayRegistry.recordFailure(username, req.url ?? "-", "桌面端不在线");
    failJson(res, 503, "网络中继不可用：桌面端不在线");
    return;
  }

  const target = resolveBaseUrl(username) + (req.url ?? "/");
  let host = "";
  try {
    host = new URL(target).host;
  } catch {
    failJson(res, 400, "目标地址不合法");
    return;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }

  const reqId = crypto.randomBytes(8).toString("hex");
  const entry: PendingRequest = {
    res,
    host,
    headersSent: false,
    idleTimer: setTimeout(() => finish(username, reqId, "中继请求超时（无数据）"), REQ_IDLE_TIMEOUT_MS),
  };
  pending.set(reqId, entry);
  relayRegistry.recordRequest(username, host);

  // 引擎侧主动断开（用户点停止/会话中断）：abort 桌面端的对端请求。
  res.on("close", () => {
    if (!pending.has(reqId)) return;
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    relayRegistry.sendTo(username, { type: "llm_cancel", req_id: reqId });
  });

  const sent = relayRegistry.sendTo(username, {
    type: "llm_request",
    req_id: reqId,
    method: (req.method ?? "GET") as "GET" | "POST" | "HEAD",
    url: target,
    headers,
    ...(body.length > 0 ? { body } : {}),
  });
  if (!sent) {
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    relayRegistry.recordFailure(username, host, "桌面端不在线");
    failJson(res, 503, "网络中继不可用：桌面端不在线");
  }
}

/**
 * 桌面端中继连接断开：立刻失败该用户全部在途桥请求，别让引擎干等到
 * 300s 无数据超时——把「长时间沉默」变「马上报错」（SDK 走既有 agent_error
 * 路径，桌面重连后下一条消息自动恢复）。
 * 调用方必须先排除 superseded 顶替：新连接已接管（isRelayOnline=true）时
 * 不能误杀在途请求。
 */
export function failPendingOnRelayDrop(username: string): void {
  const bridge = bridges.get(username);
  if (!bridge || bridge.pending.size === 0) return;
  for (const [reqId, entry] of bridge.pending) {
    clearTimeout(entry.idleTimer);
    bridge.pending.delete(reqId);
    relayRegistry.recordFailure(username, entry.host, "桌面端离线（请求中断）");
    if (entry.headersSent) {
      try {
        entry.res.write(
          `\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "网络中继中断：桌面端离线" } })}\n\n`,
        );
        entry.res.end();
      } catch {
        entry.res.destroy();
      }
    } else {
      failJson(entry.res, 503, "网络中继中断：桌面端离线");
    }
  }
}

/** 桌面端隧道帧入口（ws/relayHandler.ts 解析校验后调用）。 */
export function handleRelayClientMessage(username: string, msg: RelayClientMessage): void {
  const bridge = bridges.get(username);
  if (!bridge) return; // 桥已关：迟到帧丢弃
  const entry = bridge.pending.get(msg.req_id);
  if (!entry) return; // 未知/已结束的 req_id 一律丢弃（防伪造）
  switch (msg.type) {
    case "llm_response_head": {
      if (entry.headersSent) return;
      entry.headersSent = true;
      try {
        entry.res.writeHead(msg.status, {
          "content-type": msg.content_type ?? "application/json",
          "cache-control": "no-cache",
        });
      } catch {
        finish(username, msg.req_id, "写响应头失败");
      }
      return;
    }
    case "llm_response_chunk": {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(
        () => finish(username, msg.req_id, "中继请求超时（流中断）"),
        REQ_IDLE_TIMEOUT_MS,
      );
      if (!entry.headersSent) {
        // 容错：桌面端漏发 head 时按 200 处理
        entry.headersSent = true;
        entry.res.writeHead(200, { "content-type": "text/event-stream" });
      }
      entry.res.write(msg.data);
      return;
    }
    case "llm_response_end": {
      clearTimeout(entry.idleTimer);
      bridge.pending.delete(msg.req_id);
      if (msg.error) {
        relayRegistry.recordFailure(username, entry.host, msg.error);
        if (entry.headersSent) {
          // 头已发出无法改状态码，按 SDK 可解析的错误事件收尾
          entry.res.write(
            `\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg.error } })}\n\n`,
          );
          entry.res.end();
        } else {
          failJson(entry.res, 502, msg.error);
        }
        return;
      }
      if (!entry.headersSent) {
        entry.headersSent = true;
        entry.res.writeHead(200, { "content-type": "application/json" });
      }
      entry.res.end();
      return;
    }
  }
}

// ---------- 工具 ----------

function finish(username: string, reqId: string, error: string): void {
  const bridge = bridges.get(username);
  const entry = bridge?.pending.get(reqId);
  if (!bridge || !entry) return;
  bridge.pending.delete(reqId);
  clearTimeout(entry.idleTimer);
  relayRegistry.recordFailure(username, entry.host, error);
  if (entry.headersSent) {
    entry.res.write(
      `\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: error } })}\n\n`,
    );
    entry.res.end();
  } else {
    failJson(entry.res, 504, error);
  }
}

/** SDK/CLI 可解析的 Anthropic 风格错误体（引擎侧显示为普通 API 错误）。 */
function failJson(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}
