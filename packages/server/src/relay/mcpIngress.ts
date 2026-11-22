import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getUserServers } from "../mcpConfig.js";
import type { McpServerDef } from "@blm/protocol";
import { relayRegistry } from "./registry.js";

// 用户级 MCP 隧道入口：引擎看到的用户级 MCP 服务器（「我的」）实际
// 连接由会话主人的桌面发起，而不是服务端直连。复刻 llmBridge 的
// 共享入口模式——单一 127.0.0.1 随机端口，身份编码在路径里：
//   /u/<owner>/s/<session>/n/<name>/<引擎侧 MCP 原路径>
//     owner  —— 会话主人：决定把请求发给谁的桌面（钉死主人，MCP 是
//               其个人配置，共享会话借用宿主的能力，不做负责人候选）；
//     name   —— 服务器名：查主人的用户级配置拿真实目标/启动参数。
//
// 两类转发（用户级一律只经桌面中转，服务端绝不自己直连——能力在用户
// 的机器与网络上；注册配置摘要随帧下发，桌面知道自己在代连哪个注册项）：
// - http/sse 远程服务器：URL 原样包装成 mcp_request 由桌面转发，注册的
//   headers 由服务端注入；桌面离线即 503，无任何直连兜底。
// - stdio：桌面 spawn 子进程（spawn 参数只经隧道帧到桌面，绝不进
//   引擎面），桌面离线 → 503。
//
// 回帧复用 llm_response_head/chunk/end（head 带可选 headers 透传
// Mcp-Session-Id 等响应头）；llm_cancel 同帧族承担取消。

const REQ_CONCURRENCY_MAX = 8; // 每个桌面同时在桥上的 MCP 请求数
const REQ_IDLE_TIMEOUT_MS = 600_000; // MCP 工具调用可远慢于 LLM 流式响应
const BODY_MAX = 32 * 1024 * 1024;

// hop-by-hop 与会破坏文本性/寻址的头不转发。
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "accept-encoding",
]);

interface PendingMcp {
  res: ServerResponse;
  owner: string;
  name: string;
  host: string;
  headersSent: boolean;
  idleTimer: NodeJS.Timeout;
  /** initialize 请求：响应头须注入 Mcp-Session-Id=<值>（SDK 据此建立会话）。 */
  assignSid?: string;
}

const pending = new Map<string, PendingMcp>();

// ---------- stdio 会话映射 ----------
// MCP 的 initialize 是「连接级」握手，而 stdio 桥跑的是有状态子进程：
// 每条 MCP 客户端连接（每个引擎会话重建）都必须有自己的进程，否则第二条
// 连接的 initialize 会被已初始化的服务器以 Method not found 拒绝。
// 用协议标准的 Mcp-Session-Id 头承载：initialize 时签发，SDK 自动回传，
// ingress 换算成帧里的 conn 交桌面按连接分进程。

const MCP_SESSION_TTL_MS = 30 * 60_000;
const mcpSessions = new Map<string, { owner: string; name: string; at: number }>();

function mcpSessionSweep(): void {
  const cutoff = Date.now() - MCP_SESSION_TTL_MS;
  for (const [sid, s] of mcpSessions) {
    if (s.at < cutoff) mcpSessions.delete(sid);
  }
}

/** 解析 JSON-RPC 请求体的 method（非 JSON 或无 method = null）。 */
function rpcMethodOf(body: string): string | null {
  try {
    const m = (JSON.parse(body) as { method?: unknown }).method;
    return typeof m === "string" ? m : null;
  } catch {
    return null;
  }
}

let ingress: http.Server | null = null;
let ingressPort: number | null = null;

/** 入口端口（agent/mcp.ts 构建改写用）；未启动为 null。 */
export function mcpIngressPort(): number | null {
  return ingressPort;
}

/** 启动共享入口端口（幂等；服务启动时调用一次）。 */
export function startMcpIngress(): Promise<void> {
  if (ingress) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleIngressRequest(req, res).catch(() => {
        try {
          failJson(res, 500, "MCP 隧道内部错误");
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
      console.info(`[mcp] 用户级 MCP 隧道入口已就绪 port=${ingressPort}`);
      resolve();
    });
  });
}

/**
 * 引擎 MCP 服务器 URL 改写（agent/mcp.ts 消费）：把主人用户级服务器的
 * 真实配置替换为指向本入口的地址。入口未就绪返回 null（引擎直连原 URL，
 * 与功能不存在时一致）。公有域会话本就不挂用户级 MCP，不经过这里。
 */
export function mcpTunnelUrlFor(
  owner: string,
  sessionId: string,
  name: string,
): string | null {
  if (ingressPort == null) return null;
  return (
    `http://127.0.0.1:${ingressPort}/u/${encodeURIComponent(owner)}` +
    `/s/${encodeURIComponent(sessionId)}/n/${encodeURIComponent(name)}`
  );
}

function proxyLoad(owner: string): number {
  let n = 0;
  for (const p of pending.values()) if (p.owner === owner) n += 1;
  return n;
}

async function handleIngressRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q) : "";

  const m = /^\/u\/([^/]+)\/s\/([^/]+)\/n\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) {
    failJson(res, 404, "MCP 隧道路径不合法");
    return;
  }
  const owner = decodeURIComponent(m[1]);
  const serverName = decodeURIComponent(m[3]);

  const def = getUserServers(owner)[serverName];
  if (!def) {
    // 只转发用户级配置；全局服务器不经隧道（服务端直连）。
    failJson(res, 404, "未找到该用户的服务器配置");
    return;
  }

  // 读完整请求体（JSON-RPC 文本）。
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

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
  // 注册配置里的 headers（鉴权等）到这里才注入：引擎只见隧道地址，带不了
  // 它们。配置头覆盖同名请求头（请求头经 Node 已是小写，这里统一小写键）。
  if (def.type !== "stdio" && def.headers) {
    for (const [k, v] of Object.entries(def.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }

  if (def.type === "stdio") {
    // GET（SDK 初始化后尝试开服务端→客户端 SSE 流）：stdio 门面不提供，
    // 本地按规范回 405，SDK 视为「服务器不支持」正常继续——不值得为此
    // 打一趟桌面隧道。
    if ((req.method ?? "POST") === "GET") {
      failJson(res, 405, "stdio MCP 不提供服务端流");
      return;
    }
    // 连接身份解析：initialize = 新连接（签发会话）；其余必须带已签发的
    // Mcp-Session-Id（SDK 全程自动回传），未知会话按规范回 404——客户端
    // 重新 initialize 即可重建（服务端重启后内存会话表清空的兜底路径）。
    const sidHeader = req.headers["mcp-session-id"];
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    let conn: string | undefined;
    let assignSid: string | undefined;
    if ((req.method ?? "POST") === "DELETE") {
      // SDK terminateSession：注销会话并让桌面终结进程；会话未知也回 200
      //（规范允许服务器不接受终结，这里别让 SDK 报错）。
      const s = sid ? mcpSessions.get(sid) : undefined;
      if (s && s.owner === owner && s.name === serverName) {
        mcpSessions.delete(sid!);
        conn = sid;
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
    } else {
      const method = rpcMethodOf(body);
      if (method === "initialize") {
        mcpSessionSweep();
        conn = crypto.randomBytes(16).toString("hex");
        assignSid = conn;
        mcpSessions.set(conn, { owner, name: serverName, at: Date.now() });
      } else if (sid) {
        const s = mcpSessions.get(sid);
        if (!s || s.owner !== owner || s.name !== serverName) {
          failJson(res, 404, "MCP 会话不存在或已过期，请重新初始化");
          return;
        }
        conn = sid;
        s.at = Date.now();
      } else {
        failJson(res, 404, "缺少 Mcp-Session-Id，请先 initialize");
        return;
      }
    }
    await forwardToDesktop(res, owner, {
      method: (req.method ?? "POST") as "GET" | "POST" | "DELETE",
      name: serverName,
      headers,
      ...(body.length > 0 ? { body } : {}),
      ...(conn ? { conn } : {}),
      spawn: {
        command: def.command ?? "",
        ...(def.args ? { args: def.args } : {}),
        ...(def.env ? { env: def.env } : {}),
      },
      assignSid,
    });
    return;
  }

  // 远程 http/sse：目标 = 真实 base_url ‖ 附加路径（字符串拼接；
  // new URL(path, base) 会丢 base 自带的 path 部分）。引擎打的是隧道根
  // 路径——注册 URL 是什么就打什么，绝不强加尾斜杠（否则
  // 「http://host/mcp」会被打成「/mcp/」，严格匹配路径的服务器必 404，
  // 2026-11 tips-mcp 就栽在这）。
  const base = (def.url ?? "").replace(/\/+$/, "");
  const extra = m[4] && m[4] !== "/" ? m[4] : "";
  const target = base + extra + query;
  if (proxyLoad(owner) >= REQ_CONCURRENCY_MAX) {
    failJson(res, 429, "MCP 隧道请求并发已达上限");
    return;
  }

  const sent = sendMcpRequest(res, owner, {
    method: (req.method ?? "POST") as "GET" | "POST" | "DELETE",
    name: serverName,
    url: target,
    headers,
    ...(body.length > 0 ? { body } : {}),
    // 注册配置摘要随帧下发：桌面由此知道自己在代连哪个注册项。
    server: { type: def.type, ...(def.url ? { url: def.url } : {}) },
  });
  if (!sent) {
    // 一律桌面中转：桌面不在线就失败，服务端不直连兜底（用户级 MCP 的
    // 可达性往往只属于用户自己的网络，服务端直连只会打错机器）。
    failJson(res, 503, "MCP 隧道不可用：桌面端不在线");
  }
}

/** 把请求包装成 mcp_request 发给主人桌面；false = 桌面不在线。 */
function sendMcpRequest(
  res: ServerResponse,
  owner: string,
  frame: {
    method: "GET" | "POST" | "DELETE";
    name: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
    conn?: string;
    spawn?: { command: string; args?: string[]; env?: Record<string, string> };
    server?: { type: "http" | "sse" | "stdio"; url?: string };
    assignSid?: string;
  },
): boolean {
  const reqId = crypto.randomBytes(8).toString("hex");
  let host = "";
  if (frame.url) {
    try {
      host = new URL(frame.url).host;
    } catch {
      host = frame.url;
    }
  } else {
    host = `stdio:${frame.name}`;
  }
  const entry: PendingMcp = {
    res,
    owner,
    name: frame.name,
    host,
    headersSent: false,
    idleTimer: setTimeout(() => finish(reqId, "MCP 隧道请求超时（无数据）"), REQ_IDLE_TIMEOUT_MS),
    ...(frame.assignSid ? { assignSid: frame.assignSid } : {}),
  };
  pending.set(reqId, entry);
  console.info(`[mcp] ${owner} → 桌面 ${host}`);
  // 首字节看门狗：帧已送到 WS（在线），但桌面长时间不应答
  // ——旧版客户端不认识 mcp_request 帧会静默丢弃。别黑等
  // 600s，60s 就报「桌面无应答」让引擎侧看到明确错误。
  entry.idleTimer = setTimeout(() => {
    const cur = pending.get(reqId);
    if (cur !== entry || entry.headersSent) return; // 已有回帧则继续走 600s 超时
    console.warn(
      `[mcp] ${owner} ← 桌面 60s 无应答 (${frame.name})——桌面可能不在线或客户端版本过旧（不支持 MCP 隧道）`,
    );
    finish(reqId, "MCP 隧道不可用：桌面无应答（请确认桌面在线并已更新到最新版本）");
  }, 60_000);

  // 引擎侧断开（用户点停止/会话中断）：取消桌面端请求。
  res.on("close", () => {
    if (!pending.has(reqId)) return;
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    relayRegistry.sendTo(owner, { type: "llm_cancel", req_id: reqId });
  });

  const sent = relayRegistry.sendTo(owner, {
    type: "mcp_request",
    req_id: reqId,
    method: frame.method,
    name: frame.name,
    ...(frame.url ? { url: frame.url } : {}),
    ...(frame.headers ? { headers: frame.headers } : {}),
    ...(frame.body ? { body: frame.body } : {}),
    ...(frame.conn ? { conn: frame.conn } : {}),
    ...(frame.spawn ? { spawn: frame.spawn } : {}),
    ...(frame.server ? { server: frame.server } : {}),
  });
  if (!sent) {
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
  }
  return sent;
}

async function forwardToDesktop(
  res: ServerResponse,
  owner: string,
  frame: {
    method: "GET" | "POST" | "DELETE";
    name: string;
    headers: Record<string, string>;
    body?: string;
    conn?: string;
    spawn: { command: string; args?: string[]; env?: Record<string, string> };
    assignSid?: string;
  },
): Promise<void> {
  if (proxyLoad(owner) >= REQ_CONCURRENCY_MAX) {
    failJson(res, 429, "MCP 隧道请求并发已达上限");
    return;
  }
  const sent = sendMcpRequest(res, owner, frame);
  if (!sent) {
    failJson(res, 503, "MCP 隧道不可用：桌面端不在线");
  }
}

/**
 * 桌面端中继连接断开：立刻失败其名下在途 MCP 请求，不等 600s 超时。
 * 调用方必须先排除 superseded 顶替（与 llmBridge 同款约束）。
 */
export function failPendingMcpOnRelayDrop(username: string): void {
  for (const [reqId, entry] of pending) {
    if (entry.owner !== username) continue;
    pending.delete(reqId);
    clearTimeout(entry.idleTimer);
    failJson(entry.res, 503, "MCP 隧道中断：桌面端离线");
  }
}

/** 桌面端隧道帧入口（ws/relayHandler.ts 解析校验后调用）。 */
export function handleMcpClientMessage(
  username: string,
  msg: import("@blm/protocol").RelayClientMessage,
): void {
  const entry = pending.get(msg.req_id);
  // 未知/已结束的 req_id 一律丢弃；且回帧必须来自该请求的主人（防伪造）。
  if (!entry || entry.owner !== username) return;
  switch (msg.type) {
    case "llm_response_head": {
      if (entry.headersSent) return;      entry.headersSent = true;
      try {
        const headers: Record<string, string> = {
          "content-type": msg.content_type ?? "application/json",
          "cache-control": "no-cache",
        };
        for (const [k, v] of Object.entries(msg.headers ?? {})) {
          if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
        }
        // initialize 响应：注入会话头，SDK 从此每帧回传（stdio 会话的根）。
        if (entry.assignSid) headers["mcp-session-id"] = entry.assignSid;
        entry.res.writeHead(msg.status, headers);
      } catch {
        finish(msg.req_id, "写响应头失败");
      }
      return;
    }
    case "llm_response_chunk": {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(
        () => finish(msg.req_id, "MCP 隧道请求超时（流中断）"),
        REQ_IDLE_TIMEOUT_MS,
      );
      if (!entry.headersSent) {
        // 容错：桌面端漏发 head 时按 200 JSON 处理（stdio 桥回包形态）。
        entry.headersSent = true;
        entry.res.writeHead(200, { "content-type": "application/json" });
      }
      entry.res.write(msg.data);
      return;
    }
    case "llm_response_end": {
      clearTimeout(entry.idleTimer);
      pending.delete(msg.req_id);
      if (msg.error) {
        if (entry.headersSent) {
          // 头已发（streamable-http 可能已开始 SSE），按 JSON-RPC 错误帧收尾
          try {
            entry.res.write(
              `\nevent: error\ndata: ${JSON.stringify({ error: msg.error })}\n\n`,
            );
            entry.res.end();
          } catch {
            entry.res.destroy();
          }
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
  if (entry.headersSent) {
    try {
      entry.res.write(
        `\nevent: error\ndata: ${JSON.stringify({ error })}\n\n`,
      );
      entry.res.end();
    } catch {
      entry.res.destroy();
    }
  } else {
    failJson(entry.res, 504, error);
  }
}

function failJson(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
