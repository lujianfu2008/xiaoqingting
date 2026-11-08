import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayClientMessage } from "@blm/protocol";
import { getUserLlmConfig } from "../llmConfig.js";
import { getRelayOptIn, loadRelayConfig } from "./relayConfig.js";
import { relayRegistry } from "./registry.js";

// 网络中继 V2：消息级 LLM 桥。
//
// 单一入口端口（127.0.0.1 随机）承载所有会话，身份编码在路径里：
//   /u/<owner>[/s/<session>]/<引擎原路径>
//     owner   —— 会话主人：决定真实目标 base_url，也是密钥/账单归属；
//     session —— 协作线程：用于解析「当前负责人」（工作台跟随指派）。
//
// 每条请求现挑「代发桌面」：当前负责人桌面优先（opt-in 且 relay WS 在线），
// 其次会话主人桌面；都不可用 → 服务端直连兜底（尽力而为，被 WAF 拦的网关再
// 报错也归因准确）。之所以不在会话 env 里写死代发人：负责人会随任务流转变化，
// 写死就得每次流转重建会话。env 只固定入口，代发人逐请求解析。
//
// 代发人只提供网络：请求头（含主人的 LLM key）原样经其机器发出——协作线程
// 里这意味着任务主人的 key 会经过当前负责人的电脑（设置页文案已如实说明）。

const BODY_MAX = 32 * 1024 * 1024; // 长上下文请求体上限
const REQ_CONCURRENCY_MAX = 8; // 每个代发桌面同时在桥上的请求数
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

interface PendingRequest {
  res: ServerResponse;
  /** 请求发起人（会话主人）：统计与日志口径。 */
  owner: string;
  /** 实际代发该请求的桌面用户名——回帧必须来自此人。 */
  proxy: string;
  host: string;
  headersSent: boolean;
  idleTimer: NodeJS.Timeout;
}

const pending = new Map<string, PendingRequest>();

let ingress: http.Server | null = null;
let ingressPort: number | null = null;

/** 会话 → 当前负责人（TaskManager 晚绑定注入，避免 relay 依赖 agent 层）。 */
type ProxyResolver = (sessionId: string) => string | null;
let proxyResolver: ProxyResolver | null = null;

export function setRelayProxyResolver(fn: ProxyResolver): void {
  proxyResolver = fn;
}

/** 入口端口（compat 层直连入口用）；未启动为 null。 */
export function relayIngressPort(): number | null {
  return ingressPort;
}

/** 候选代发人：当前负责人优先，其次会话主人（去重）。 */
function proxyCandidates(owner: string, sessionId?: string | null): string[] {
  const exec = sessionId ? (proxyResolver?.(sessionId) ?? null) : null;
  return exec && exec !== owner ? [exec, owner] : [owner];
}

/** 当前可用的代发桌面（总开关 + opt-in + relay WS 在线）；null = 无桌面可借。 */
export function relayProxyFor(owner: string, sessionId?: string | null): string | null {
  if (!loadRelayConfig().enabled) return null;
  for (const u of proxyCandidates(owner, sessionId)) {
    if (getRelayOptIn(u) && relayRegistry.isRelayOnline(u)) return u;
  }
  return null;
}

/** 该会话本可借网（总开关开 + 至少一位候选代发人 opt-in）：入口/直连兜底的门槛。 */
export function relayEligible(owner: string, sessionId?: string | null): boolean {
  return (
    loadRelayConfig().enabled &&
    proxyCandidates(owner, sessionId).some((u) => getRelayOptIn(u))
  );
}

/**
 * 引擎 env 注入（sessionOptions 消费）：至少一位候选代发人 opt-in 时，把引擎
 * 指向入口。桌面此刻离线也注入——请求时才挑代发人，桌面重连后无需重建会话；
 * 返回 null = 不注入，引擎直连（中继关/未 opt-in/入口未就绪，与功能不存在时一致）。
 */
export function relayIngressFor(owner: string, sessionId?: string | null): string | null {
  if (ingressPort == null || !relayEligible(owner, sessionId)) return null;
  const sid = sessionId ? `/s/${encodeURIComponent(sessionId)}` : "";
  return `http://127.0.0.1:${ingressPort}/u/${encodeURIComponent(owner)}${sid}`;
}

/** 引擎请求的真实目标（与 sessionOptions 的 env 逻辑同源）：主人个人 base_url ‖ 全局 env ‖ 官方默认。 */
function resolveBaseUrl(owner: string): string {
  const personal = getUserLlmConfig(owner)?.base_url?.trim();
  return (
    (personal || process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    )
  );
}

function proxyLoad(proxy: string): number {
  let n = 0;
  for (const p of pending.values()) if (p.proxy === proxy) n += 1;
  return n;
}

/** 启动共享入口端口（幂等；服务启动时调用一次）。 */
export function startRelayIngress(): Promise<void> {
  if (ingress) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleIngressRequest(req, res).catch(() => {
        try {
          failJson(res, 500, "中继内部错误");
        } catch {
          // headers already sent
        }
      });
    });
    server.on("clientError", (_err, sock) => sock.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      ingress = server;
      ingressPort = (server.address() as { port: number }).port;
      console.info(`[relay] 中继入口已就绪 port=${ingressPort}`);
      resolve();
    });
  });
}

// ---------- 引擎请求入口 ----------

/**
 * 引擎请求入口（纯 Anthropic 协议）。
 *
 * 有桌面可借 → 包装成 llm_request 由桌面代发；没有（桌面全离线/被禁用）→
 * **服务端直连**，不把可用的网关打成不可用。直连兜底只在「本可借网」时启用
 * （总开关开 + 至少一人 opt-in，即 env 已指向入口）；否则入口对未启用中继的
 * 会话来说是陌生端点，仍按 503 拒绝，避免它变成隐形的公开出网代理。
 */
async function handleIngressRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q) : "";

  const m = /^\/u\/([^/]+)(?:\/s\/([^/]+))?(\/.*)?$/.exec(path);
  if (!m) {
    failJson(res, 404, "中继路径不合法");
    return;
  }
  const owner = decodeURIComponent(m[1]);
  const sessionId = m[2] ? decodeURIComponent(m[2]) : undefined;
  const enginePath = (m[3] ?? "/") + query;

  // SDK 对引擎 base 做探活（HEAD <base>/api/hello）：直接答 200——探活不代表
  // 有桌面可借，不该因代发人离线把引擎启动卡在 503 上。
  if (req.method === "HEAD" && enginePath.startsWith("/api/hello")) {
    res.writeHead(200);
    res.end();
    return;
  }

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

  const proxy = relayProxyFor(owner, sessionId);
  if (!proxy) {
    if (relayEligible(owner, sessionId)) {
      // 桌面端全部离线：退回服务端直连（尽力而为；被 WAF 拦的网关会报错，
      // 与「中继未曾可用」同源，不再凭空造 503）。
      await passThroughDirect(req, res, owner, enginePath, body);
      return;
    }
    relayRegistry.recordFailure(owner, req.url ?? "-", "桌面端不在线");
    failJson(res, 503, "网络中继不可用：桌面端不在线");
    return;
  }
  if (proxyLoad(proxy) >= REQ_CONCURRENCY_MAX) {
    failJson(res, 429, "中继请求并发已达上限");
    return;
  }

  const target = resolveBaseUrl(owner) + enginePath;
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
    owner,
    proxy,
    host,
    headersSent: false,
    idleTimer: setTimeout(() => finish(reqId, "中继请求超时（无数据）"), REQ_IDLE_TIMEOUT_MS),
  };
  pending.set(reqId, entry);
  relayRegistry.recordRequest(owner, host);
  console.info(
    `[relay] ${owner}${sessionId ? ` (session ${sessionId})` : ""} → 代发 ${proxy} ${host}${enginePath.split("?")[0]}`,
  );

  // 引擎侧主动断开（用户点停止/会话中断）：abort 桌面端的对端请求。
  res.on("close", () => {
    if (!pending.has(reqId)) return;
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    relayRegistry.sendTo(proxy, { type: "llm_cancel", req_id: reqId });
  });

  const sent = relayRegistry.sendTo(proxy, {
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
    relayRegistry.recordFailure(owner, host, "桌面端不在线");
    failJson(res, 503, "网络中继不可用：桌面端不在线");
  }
}

/**
 * 无桌面可借时的服务端直连兜底：把引擎请求原样转发到主人的真实目标，响应
 * 逐块写回（含 SSE）。直连失败按 Anthropic 错误体返回，让 SDK 走常规错误
 * 路径而不是把问题归因于中继。
 */
async function passThroughDirect(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  enginePath: string,
  body: string,
): Promise<void> {
  const target = resolveBaseUrl(owner) + enginePath;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let host = target;
  try {
    host = new URL(target).host;
  } catch {
    // keep full target in the log line
  }
  relayRegistry.recordRequest(owner, host);
  console.info(`[relay] ${owner} → 直连兜底 ${host}${enginePath.split("?")[0]}`);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method ?? "POST",
      headers,
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)]),
    });
  } catch (err) {
    relayRegistry.recordFailure(owner, host, (err as Error).message);
    failJson(res, 502, `直连上游失败：${(err as Error).message}`);
    return;
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    relayRegistry.recordFailure(owner, host, `HTTP ${upstream.status}`);
    console.warn(`[relay] 直连兜底上游 ${upstream.status} ← ${host} | ${text.slice(0, 300)}`);
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
    return;
  }
  if (res.destroyed) return;
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-cache",
  });
  try {
    for await (const chunk of upstream.body ?? []) {
      if (res.destroyed) break;
      res.write(chunk as Buffer);
    }
  } catch (err) {
    relayRegistry.recordFailure(owner, host, (err as Error).message);
  } finally {
    res.end();
  }
}

/**
 * 桌面端中继连接断开：立刻失败其代发的全部在途请求，别让引擎干等到 300s
 * 无数据超时——把「长时间沉默」变「马上报错」（SDK 走既有 agent_error 路径，
 * 桌面重连后下一条消息自动恢复）。
 * 调用方必须先排除 superseded 顶替：新连接已接管（isRelayOnline=true）时
 * 不能误杀在途请求。
 */
export function failPendingOnRelayDrop(username: string): void {
  failPendingForProxy(username, 503, "网络中继中断：桌面端离线");
}

/** 某代发人停止借网（opt-out/被禁用）：其名下在途请求立即失败。 */
export function failPendingForProxy(username: string, status: number, message: string): void {
  failPendingWhere((e) => e.proxy === username, status, message);
}

/** 中继总开关关闭 / 功能下线：全部在途请求立即失败。 */
export function failAllPending(status: number, message: string): void {
  failPendingWhere(() => true, status, message);
}

function failPendingWhere(
  pred: (e: PendingRequest) => boolean,
  status: number,
  message: string,
): void {
  for (const [reqId, entry] of pending) {
    if (!pred(entry)) continue;
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    relayRegistry.recordFailure(entry.owner, entry.host, message);
    if (entry.headersSent) {
      try {
        entry.res.write(
          `\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
        );
        entry.res.end();
      } catch {
        entry.res.destroy();
      }
    } else {
      failJson(entry.res, status, message);
    }
  }
}

/** 桌面端隧道帧入口（ws/relayHandler.ts 解析校验后调用）。 */
export function handleRelayClientMessage(username: string, msg: RelayClientMessage): void {
  const entry = pending.get(msg.req_id);
  // 未知/已结束的 req_id 一律丢弃；且回帧必须来自该请求的代发人（防伪造）。
  if (!entry || entry.proxy !== username) return;
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
        finish(msg.req_id, "写响应头失败");
      }
      return;
    }
    case "llm_response_chunk": {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(
        () => finish(msg.req_id, "中继请求超时（流中断）"),
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
      pending.delete(msg.req_id);
      if (msg.error) {
        relayRegistry.recordFailure(entry.owner, entry.host, msg.error);
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

function finish(reqId: string, error: string): void {
  const entry = pending.get(reqId);
  if (!entry) return;
  pending.delete(reqId);
  clearTimeout(entry.idleTimer);
  relayRegistry.recordFailure(entry.owner, entry.host, error);
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
