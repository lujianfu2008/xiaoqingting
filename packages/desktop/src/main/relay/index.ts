import { StringDecoder } from "node:string_decoder";
import type { ClientRequest } from "electron";
import { LlmRequest, RelayServerMessage, type RelayConfigure } from "@blm/protocol";
import WebSocket from "ws";

// 桌面端中继连接（main 进程专用，/ws/relay）：把本机网络借给服务端引擎。
// V2 是消息级桥——收到 llm_request（完整 method/url/headers/body）后用本机
// 网络发起真实请求，把响应状态与 UTF-8 文本分片（SSE）流式回传给服务端桥，
// 桥原样写回引擎。目标 URL 由服务端逐请求给定，桌面不做任何目标决策。
// token 只存内存、绝不写盘；断线指数退避重连；应用层心跳（25s ping，超时
// 判死 terminate，服务端的协议层 ping 由 ws 库自动回 pong）。

const RELAY_REQUEST_MAX = 16; // 服务端限 8/用户，这里放宽做对称防御

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  active_requests: number;
  requests_total: number;
  requests_failed: number;
}

// hop-by-hop 头不透传（服务端转发前已剔除，这里双保险；Electron 会自行计算
// host/content-length）。accept-encoding 再剔一次，防压缩响应破坏文本分片。
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "accept-encoding",
]);

// ---------- 真实 HTTP 执行器（可注入桩便于 node 级测试） ----------

interface ExecCallbacks {
  onResponse(status: number, contentType?: string): void;
  onData(text: string): void;
  onEnd(err?: string): void;
}

export type HttpExecutor = (
  req: { method: string; url: string; headers: Record<string, string>; body?: string },
  cb: ExecCallbacks,
) => { abort(): void };

/** Electron net.request（Chromium 网络栈：自动跟随系统代理/PAC）。 */
function electronExecutor(): HttpExecutor {
  // 延迟 require：普通 node 环境（测试）加载本模块时不碰 electron API。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { net } = require("electron") as typeof import("electron");
  return (req, cb) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    }
    const creq: ClientRequest = net.request({ method: req.method, url: req.url });
    for (const [k, v] of Object.entries(headers)) creq.setHeader(k, v);
    let finished = false;
    creq.on("response", (res) => {
      const ct = res.headers["content-type"];
      cb.onResponse(res.statusCode ?? 0, Array.isArray(ct) ? ct.join(", ") : ct);
      // StringDecoder 兜住跨 chunk 边界的多字节 UTF-8 字符。
      const decoder = new StringDecoder("utf8");
      res.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (text) cb.onData(text);
      });
      res.on("end", () => {
        if (finished) return;
        finished = true;
        const tail = decoder.end();
        if (tail) cb.onData(tail);
        cb.onEnd();
      });
      res.on("error", (err: Error) => {
        if (finished) return;
        finished = true;
        cb.onEnd(err.message);
      });
    });
    creq.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      // 带上目标与请求形态：ERR_INVALID_ARGUMENT 这类环境性错误（系统代理/
      // 拦截等）没有上下文根本没法定位。
      let target = "";
      try {
        const u = new URL(req.url);
        target = `${u.host}${u.pathname}`;
      } catch {
        target = req.url;
      }
      cb.onEnd(`${err.message} (${req.method} ${target})`);
    });
    creq.end(req.body ?? undefined);
    return {
      abort: () => {
        try {
          creq.abort();
        } catch {
          // already done
        }
      },
    };
  };
}

// Node 直连在「连接期」失败的错误（区别于流中断）：换下一通道的依据。
const CONNECT_FAIL_RE = /\b(ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b/;

/**
 * Node 自带网络栈（http/https，OpenSSL 校验，不读系统代理/PAC）。传 proxyUrl
 * 时先对代理发 CONNECT 建隧道，再在其上做 TLS/HTTP（HTTPS_PROXY 指向 Clash
 * 等本地代理的 HTTP 端口），覆盖「必须借代理才能到达网关」的网络。响应同样
 * 按 UTF-8 文本分片回传。
 */
function nodeHttpExecutor(proxyUrl?: URL): HttpExecutor {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const http = require("node:http") as typeof import("node:http");
  const https = require("node:https") as typeof import("node:https");
  const tls = require("node:tls") as typeof import("node:tls");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return (req, cb) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      cb.onEnd(`目标 URL 不合法: ${req.url}`);
      return { abort: () => undefined };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    }
    if (req.body != null) headers["content-length"] = String(Buffer.byteLength(req.body, "utf8"));

    let stopped = false;
    let current: { destroy(): void } | null = null;
    const destroyCurrent = (): void => {
      try {
        current?.destroy();
      } catch {
        // already destroyed
      }
    };

    const sendRequest = (conn?: () => import("node:net").Socket): void => {
      const mod = u.protocol === "http:" ? http : https;
      const creq = (mod.request as typeof http.request)(
        u,
        {
          method: req.method,
          headers,
          ...(conn ? { createConnection: conn, agent: false } : {}),
        },
        (res) => {
          const ct = res.headers["content-type"];
          cb.onResponse(res.statusCode ?? 0, ct);
          const decoder = new StringDecoder("utf8");
          res.on("data", (chunk: Buffer) => {
            const text = decoder.write(chunk);
            if (text) cb.onData(text);
          });
          res.on("end", () => {
            const tail = decoder.end();
            if (tail) cb.onData(tail);
            cb.onEnd();
          });
          res.on("error", (err: Error) => cb.onEnd(err.message));
        },
      );
      current = creq;
      if (stopped) {
        destroyCurrent();
        return;
      }
      creq.on("error", (err: Error) => cb.onEnd(err.message));
      if (req.body != null) creq.write(req.body);
      creq.end();
    };

    if (!proxyUrl) {
      sendRequest();
      return {
        abort: () => {
          stopped = true;
          destroyCurrent();
        },
      };
    }

    // CONNECT 隧道（仅 https 目标；先对代理 CONNECT，成功后在隧道上 TLS）。
    const port = u.port || (u.protocol === "http:" ? "80" : "443");
    const preq = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: "CONNECT",
      path: `${u.hostname}:${port}`,
      headers: { host: `${u.hostname}:${port}` },
    });
    current = preq;
    preq.on("connect", (res, socket) => {
      socket.on("error", (err: Error) => cb.onEnd(`代理隧道中断: ${err.message}`));
      if (stopped) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        cb.onEnd(`代理 CONNECT 失败: HTTP ${res.statusCode}`);
        return;
      }
      if (u.protocol !== "https:") {
        socket.destroy();
        cb.onEnd("经代理的 http 目标不支持（仅 https）");
        return;
      }
      sendRequest(() => tls.connect({ socket, servername: u.hostname }));
    });
    preq.on("error", (err: Error) => cb.onEnd(`代理不可达: ${err.message}`));
    preq.end();
    return {
      abort: () => {
        stopped = true;
        destroyCurrent();
      },
    };
  };
}

// 这些错误是「栈级拒绝」而非网络失败：请求还没出门就被本机 Chromium 环境
// （系统代理/安全软件/旧构建的 net 模块）打回。判定必须用包含匹配——底层
// executor 会在错误消息后追加目标上下文（"(POST host/path)"），锚定全等
// 匹配永远失配（首个版本栽在这：降级一次都没触发过）。除 ABORTED 外的
// net 栈错误都值得换栈一试。
const STACK_FALLBACK_RE = /ERR_(?!ABORTED)[A-Z_]+/;

/**
 * 通道链：Chromium（跟系统代理/PAC）→ 配置了 HTTPS_PROXY/HTTP_PROXY 时走
 * 代理隧道 → Node 直连。每一级只在「连接期失败」时把请求交给下一级；上游
 * 一旦回了响应头，之后的错误按流中断如实上报，不再换通道。
 */
function compositeExecutor(): HttpExecutor {
  const chromium = electronExecutor();
  const proxyRaw =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  let proxyUrl: URL | null = null;
  if (proxyRaw?.trim()) {
    try {
      proxyUrl = new URL(proxyRaw.trim());
    } catch {
      proxyUrl = null;
    }
  }
  const direct = nodeHttpExecutor();
  const viaProxy = proxyUrl ? nodeHttpExecutor(proxyUrl) : null;
  return (req, cb) => {
    let settled = false; // 已向桥回过响应头
    let done = false; // 已进入终态
    let active: { abort(): void };
    const cbs = (
      label: string,
      take: ((err: string) => boolean) | null,
      next: (() => void) | null,
    ): ExecCallbacks => ({
      onResponse: (status, ct) => {
        if (done || settled) return;
        settled = true;
        cb.onResponse(status, ct);
      },
      onData: (text) => {
        if (!done) cb.onData(text);
      },
      onEnd: (err) => {
        if (done) return;
        if (!settled && err && next && take?.(err)) {
          console.error(`[relay] ${label} 未送达（${err}），切换下一通道`);
          next();
          return;
        }
        done = true;
        if (err) {
          console.error(
            `[relay] ${label} 请求失败 ${err} (electron ${process.versions.electron ?? "?"}/node ${process.versions.node ?? "?"})`,
          );
        }
        cb.onEnd(err);
      },
    });
    const startDirect = (): void => {
      active = direct(req, cbs("Node 直连", null, null));
    };
    const startProxy = (): void => {
      if (viaProxy) {
        active = viaProxy(req, cbs("代理隧道", (e) => CONNECT_FAIL_RE.test(e), startDirect));
      } else {
        startDirect();
      }
    };
    active = chromium(req, cbs("Chromium", (e) => STACK_FALLBACK_RE.test(e), startProxy));
    return {
      abort: () => {
        done = true;
        try {
          active.abort();
        } catch {
          // already done
        }
      },
    };
  };
}

class RelayClient {
  private config: RelayConfigure | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, { abort(): void }>();
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private lastPing = 0;
  private requestsTotal = 0;
  private requestsFailed = 0;
  private executor: HttpExecutor | null = null;

  /** 测试注入桩（node 下 electron net 不可用）；不注入则用 Electron net。 */
  setHttpExecutor(exec: HttpExecutor): void {
    this.executor = exec;
  }

  /** renderer 登录后下发配置（enabled=false 仅断开，凭证字段可为空）。 */
  configure(cfg: RelayConfigure): void {
    const prev = this.config;
    this.config = cfg;
    const changed =
      !prev ||
      prev.enabled !== cfg.enabled ||
      prev.server_url !== cfg.server_url ||
      prev.token !== cfg.token;
    if (!cfg.enabled) {
      this.shutdown();
      return;
    }
    if (changed || (!this.ws && !this.retryTimer)) this.open();
  }

  status(): RelayStatus {
    return {
      enabled: this.config?.enabled ?? false,
      connected: this.ws?.readyState === WebSocket.OPEN,
      active_requests: this.pending.size,
      requests_total: this.requestsTotal,
      requests_failed: this.requestsFailed,
    };
  }

  // ---------- 连接管理 ----------

  private open(): void {
    this.teardownSocket();
    const cfg = this.config;
    if (!cfg?.enabled) return;
    let url: URL;
    try {
      url = new URL(cfg.server_url.trim().replace(/\/+$/, ""));
    } catch {
      return;
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws/relay`;
    const ws = new WebSocket(`${url.toString()}?token=${encodeURIComponent(cfg.token)}`);
    this.ws = ws;
    this.lastPong = Date.now();
    this.lastPing = Date.now();

    ws.on("open", () => {
      this.attempt = 0;
      this.lastPong = Date.now();
      this.pingTimer = setInterval(() => {
        const now = Date.now();
        // 25s 一次 ping；两个周期（35s）无 pong 判死，terminate 走 onclose 重连。
        if (now - this.lastPing >= 25_000) {
          this.lastPing = now;
          try {
            ws.ping();
          } catch {
            // closing
          }
        }
        if (now - this.lastPong > 35_000) ws.terminate();
      }, 5_000);
    });
    ws.on("pong", () => {
      this.lastPong = Date.now();
    });
    ws.on("message", (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const msg = RelayServerMessage.safeParse(parsed);
      if (!msg.success) return; // 非法/未知帧一律丢弃
      if (msg.data.type === "llm_request") this.handleRequest(msg.data);
      // llm_cancel：服务端已放弃该响应（引擎侧中断），abort 本端请求。
      else this.pending.get(msg.data.req_id)?.abort();
    });
    ws.on("close", () => {
      this.clearPing();
      // 连接断了：在途请求全部 abort（服务端侧也会对引擎回 503，双保险）。
      for (const h of this.pending.values()) h.abort();
      this.pending.clear();
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // close 事件随后触发统一清理与重连
    });
  }

  private scheduleReconnect(): void {
    if (!this.config?.enabled || this.retryTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private teardownSocket(): void {
    this.clearPing();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "reconfigure");
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  shutdown(): void {
    this.teardownSocket();
    for (const h of this.pending.values()) h.abort();
    this.pending.clear();
    this.attempt = 0;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ---------- 桥接帧 ----------

  private handleRequest(msg: LlmRequest): void {
    if (this.pending.size >= RELAY_REQUEST_MAX) {
      this.send({ type: "llm_response_end", req_id: msg.req_id, error: "请求并发已达上限" });
      return;
    }
    this.requestsTotal += 1;
    let handle: { abort(): void } = { abort: () => undefined };
    handle = this.executorOrElectron()(
      { method: msg.method, url: msg.url, headers: msg.headers, body: msg.body },
      {
        onResponse: (status, contentType) => {
          this.send({
            type: "llm_response_head",
            req_id: msg.req_id,
            status,
            ...(contentType ? { content_type: contentType } : {}),
          });
        },
        onData: (data) => {
          this.send({ type: "llm_response_chunk", req_id: msg.req_id, data });
        },
        onEnd: (err) => {
          if (this.pending.get(msg.req_id) === handle) this.pending.delete(msg.req_id);
          if (err) this.requestsFailed += 1;
          this.send({
            type: "llm_response_end",
            req_id: msg.req_id,
            ...(err ? { error: err.slice(0, 300) } : {}),
          });
        },
      },
    );
    this.pending.set(msg.req_id, handle);
  }

  private executorOrElectron(): HttpExecutor {
    if (!this.executor) this.executor = compositeExecutor();
    return this.executor;
  }
}

export const relayClient = new RelayClient();
