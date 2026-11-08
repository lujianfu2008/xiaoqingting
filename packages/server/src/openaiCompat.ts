import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getUserLlmConfig } from "./llmConfig.js";
import { relayProxyFor, relayIngressPort } from "./relay/llmBridge.js";

// OpenAI 协议适配层：把 Claude 引擎的 Anthropic Messages 请求翻译成
// OpenAI chat/completions（国内网关大多只说 OpenAI 协议）。
//
// 链路：引擎 → 本翻译端口 /t/<user>/s/<session>/v1/messages → (共享中继入口 ‖
// 直连) → 上游网关。鉴权在服务端注入（存储的个人 key），引擎带来的认证头一律
// 忽略。session 只用于解析「当前负责人」：很多网关（如联通 AIGW）拦数据中心
// IP 的 POST，只有用户桌面网络可达——负责人桌面可用就先借它，其次主人的；
// 都不可用（中继没开、无人 opt-in 或桌面全离线）则服务端直连。
//
// 对引擎而言这是一个标准的 Anthropic 端点：流式回 Anthropic SSE 事件序列，
// 非流式回 Anthropic message JSON，错误回 Anthropic error JSON。

// ---------- 类型（结构化最小集，不引 SDK） ----------

interface AnthropicBlock {
  type: string;
  text?: string;
  source?: unknown;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages?: { role: string; content: string | AnthropicBlock[] }[];
  system?: string | AnthropicBlock[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters?: unknown } }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const IMAGE_PLACEHOLDER = "[图片略：当前模型不支持视觉输入]";

// ---------- 请求翻译：Anthropic → OpenAI ----------

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : ""))
      .join("");
  }
  return "";
}

export function anthropicToOpenAiRequest(body: AnthropicRequest, model: string): OpenAiRequest {
  const messages: OpenAiMessage[] = [];

  const system = body.system;
  if (system) {
    const text = typeof system === "string" ? system : blockText(system);
    if (text) messages.push({ role: "system", content: text });
  }

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }
    // 块数组：assistant 可能带 text + tool_use（合成一条消息的 content +
    // tool_calls）；user 可能带 text + tool_result（tool_result 必须紧跟在
    // 带 tool_calls 的 assistant 消息之后，OpenAI 协议按这个顺序校验）。
    let textParts: string[] = [];
    let toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    const flushAssistant = (): void => {
      if (msg.role !== "assistant") return;
      const content = textParts.join("");
      if (content || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      textParts = [];
      toolCalls = [];
    };
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(String(block.text ?? ""));
      } else if (block.type === "image") {
        textParts.push(IMAGE_PLACEHOLDER);
      } else if (block.type === "tool_use") {
        // 不 flush：text 与 tool_calls 合并进同一条 assistant 消息（OpenAI
        // 规范形态，严格网关会拒收连续两条 assistant）。
        toolCalls.push({
          id: String(block.id ?? ""),
          type: "function",
          function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        flushAssistant();
        messages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id ?? ""),
          content: blockText(block.content) || (block.is_error ? "工具执行出错" : ""),
        });
      }
    }
    if (msg.role === "assistant") {
      flushAssistant();
    } else if (textParts.length > 0) {
      messages.push({ role: "user", content: textParts.join("") });
    }
  }

  const out: OpenAiRequest = { model, messages };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice =
      tc.type === "auto"
        ? "auto"
        : tc.type === "any"
          ? "required"
          : tc.type === "none"
            ? "none"
            : tc.type === "tool" && tc.name
              ? { type: "function", function: { name: tc.name } }
              : "auto";
  }
  if (body.stream) out.stream = true;
  return out;
}

// ---------- 响应翻译：OpenAI → Anthropic ----------

function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function errorTypeForStatus(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "api_error";
}

export function openAiResponseToAnthropic(data: OpenAiResponse, model: string): unknown {
  const choice = data.choices?.[0];
  const content: unknown[] = [];
  const text = choice?.message?.content;
  if (text) content.push({ type: "text", text });
  for (const tc of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return {
    id: data.id ?? `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * 流式翻译器：喂入上游 OpenAI SSE 文本片段（跨 chunk 断行安全），吐出
 * Anthropic SSE 事件文本。end() 收尾（补齐未闭合块与结束事件）。
 */
export class OpenAiStreamTranslator {
  private model: string;
  private buf = "";
  private started = false;
  private textOpen = false;
  private nextIndex = 0;
  /** OAI tool index → 本端块状态。 */
  private tools = new Map<number, { blockIndex: number; open: boolean }>();
  private usage = { input_tokens: 0, output_tokens: 0 };
  private stopReason: string | null = null;
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  private event(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private ensureStarted(): string {
    if (this.started) return "";
    this.started = true;
    return this.event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeText(): string {
    if (!this.textOpen) return "";
    this.textOpen = false;
    // text 块固定占 index 0
    return this.event("content_block_stop", { type: "content_block_stop", index: 0 });
  }

  /** 喂入任意长度的上游 SSE 文本；返回需要写给引擎的 Anthropic SSE 文本。 */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      out += this.handleLine(line);
      idx = this.buf.indexOf("\n");
    }
    return out;
  }

  /** 上游流结束：冲刷缓冲、闭合一切、产出结束事件。 */
  end(): string {
    let out = this.handleLine(this.buf.replace(/\r$/, ""));
    this.buf = "";
    if (!this.finished) out += this.finish();
    return out;
  }

  private handleLine(line: string): string {
    if (!line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return "";
    let chunk: {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return ""; // 非 JSON 行（网关注入的广告/日志行）跳过
    }
    let out = this.ensureStarted();
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (chunk.usage) {
      this.usage = {
        input_tokens: chunk.usage.prompt_tokens ?? this.usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? this.usage.output_tokens,
      };
    }
    if (delta?.content) {
      if (!this.textOpen) {
        this.closeText();
        this.textOpen = true;
        out += this.event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }
      out += this.event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    for (const tc of delta?.tool_calls ?? []) {
      let st = this.tools.get(tc.index);
      if (!st) {
        this.closeText();
        st = { blockIndex: this.nextIndex++, open: true };
        this.tools.set(tc.index, st);
        out += this.event("content_block_start", {
          type: "content_block_start",
          index: st.blockIndex,
          content_block: { type: "tool_use", id: tc.id ?? `toolu_${tc.index}`, name: tc.function?.name ?? "", input: {} },
        });
      }
      const args = tc.function?.arguments;
      if (args) {
        out += this.event("content_block_delta", {
          type: "content_block_delta",
          index: st.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }
    if (choice?.finish_reason) this.stopReason = mapStopReason(choice.finish_reason);
    return out;
  }

  private finish(): string {
    this.finished = true;
    let out = "";
    if (!this.started) out += this.ensureStarted();
    out += this.closeText();
    for (const st of this.tools.values()) {
      if (st.open) {
        st.open = false;
        out += this.event("content_block_stop", { type: "content_block_stop", index: st.blockIndex });
      }
    }
    out += this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
      usage: this.usage,
    });
    out += this.event("message_stop", { type: "message_stop" });
    return out;
  }
}

// ---------- HTTP 服务 ----------

let compatPort: number | null = null;

/** 引擎 env 用：翻译端点根（含按用户路由的前缀）；未启动返回 null。 */
export function openaiCompatBaseFor(): string | null {
  return compatPort == null ? null : `http://127.0.0.1:${compatPort}`;
}

function sse(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 上游地址：借用在线桌面（当前负责人优先、会话主人兜底）转发；没有桌面可借
 *  时若本可借网则服务端直连（尽力而为），否则返回 null 让调用方报配置错误。
 *  ≥1 台桌面在线时必须借——桌面离线时要直连（2026-11-02 的坑：桥端口常年
 *  监听，但桌面离线时桥回 503，不先判在线等于把可直连的网关永久打成不可用）。 */
function upstreamFor(
  username: string,
  sessionId: string | null,
  cfg: { base_url?: string },
): { url: string; viaRelay: boolean; proxy?: string } | null {
  const ingress = relayIngressPort();
  const proxy = ingress != null ? relayProxyFor(username, sessionId) : null;
  if (proxy && ingress != null) {
    return {
      url: `http://127.0.0.1:${ingress}/u/${encodeURIComponent(username)}${sessionId ? `/s/${encodeURIComponent(sessionId)}` : ""}/chat/completions`,
      viaRelay: true,
      proxy,
    };
  }
  const base = cfg.base_url?.replace(/\/+$/, "");
  if (!base) return null;
  return { url: `${base}/chat/completions`, viaRelay: false };
}

async function handleMessages(
  username: string,
  sessionId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cfg = getUserLlmConfig(username);
  if (!cfg?.api_key) {
    sse(res, 401, "authentication_error", "未配置个人 LLM Key（OpenAI 协议需要）。");
    return;
  }
  const raw = await readBody(req, 32 * 1024 * 1024);
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw) as AnthropicRequest;
  } catch {
    sse(res, 400, "invalid_request_error", "请求体不是合法 JSON。");
    return;
  }
  // 模型优先用个人配置里的（与 sessionOptions 的解析一致）。
  const model = cfg.model?.trim() || body.model || "";
  if (!model) {
    sse(res, 400, "invalid_request_error", "缺少模型名。");
    return;
  }
  const upstream = upstreamFor(username, sessionId, cfg);
  if (!upstream) {
    sse(res, 400, "invalid_request_error", "OpenAI 协议需要在 LLM 设置里填写 base_url。");
    return;
  }
  console.info(
    `[llm] ${username} model=${model} → ${upstream.viaRelay ? `中继桥(代发 ${upstream.proxy})` : "直连"} ${upstream.url}`,
  );

  const oaiBody = anthropicToOpenAiRequest(body, model);
  // 引擎侧断开（点停止）→ 连带 abort 上游；10 分钟兜底超时。
  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort());
  const doFetch = (withUsageOption: boolean): Promise<Response> =>
    fetch(upstream.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify(
        withUsageOption && oaiBody.stream
          ? { ...oaiBody, stream_options: { include_usage: true } }
          : oaiBody,
      ),
      signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(600_000)]),
    });

  let upstreamRes: Response;
  try {
    upstreamRes = await doFetch(true);
    // 个别网关不认 stream_options：去掉重试一次。
    if (!upstreamRes.ok && (upstreamRes.status === 400 || upstreamRes.status === 422)) {
      upstreamRes = await doFetch(false);
    }
  } catch (err) {
    sse(res, 502, "api_error", `上游请求失败：${(err as Error).message} (${upstream.url})`);
    return;
  }
  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => "");
    console.warn(`[llm] 上游 ${upstreamRes.status} ← ${upstream.url} | ${text.slice(0, 300)}`);
    sse(
      res,
      upstreamRes.status,
      errorTypeForStatus(upstreamRes.status),
      text.slice(0, 500) || `上游返回 ${upstreamRes.status}`,
    );
    return;
  }

  if (!body.stream) {
    let data: OpenAiResponse;
    try {
      data = (await upstreamRes.json()) as OpenAiResponse;
    } catch {
      sse(res, 502, "api_error", "上游响应不是合法 JSON。");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(openAiResponseToAnthropic(data, model)));
    return;
  }

  // 流式：SSE → SSE
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const translator = new OpenAiStreamTranslator(model);
  const decoder = new TextDecoder("utf-8");
  try {
    for await (const c of upstreamRes.body ?? []) {
      const out = translator.push(decoder.decode(c as Buffer, { stream: true }));
      if (out) res.write(out);
    }
    const tail = translator.push(decoder.decode());
    res.write(tail + translator.end());
  } catch (err) {
    // 流中断：按 Anthropic error 事件收尾（引擎按 API 错误处理）。
    const out =
      translator.end() +
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `流中断：${(err as Error).message}` },
      })}\n\n`;
    res.write(out);
  } finally {
    res.end();
  }
}

/** 启动共享翻译端口（一次即可，按路径前缀 /t/<user> 路由到对应用户配置）。 */
export function startOpenAiCompatServer(): Promise<void> {
  if (compatPort != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleCompatRequest(req, res).catch(() => {
        try {
          sse(res, 500, "api_error", "翻译层内部错误。");
        } catch {
          // headers already sent
        }
      });
    });
    server.on("clientError", (_err, sock) => sock.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      compatPort = (server.address() as { port: number }).port;
      console.info(`[llm] OpenAI 协议适配层已就绪 port=${compatPort}`);
      resolve();
    });
  });
}

async function handleCompatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 只回答 POST /t/<user>[/s/<session>]/v1/messages[/count_tokens]，其余一律
  // Anthropic 404。引擎（Claude CLI）实际请求带查询参数（v1/messages?beta=true）
  // ——路由前必须剥掉。session 可缺省（老会话的 base_url 没有它）：
  // 缺省时代发人解析退化为「只用会话主人」。
  const path = (req.url ?? "").split("?")[0];
  // SDK 对引擎 base 做探活（HEAD <base>/api/hello）：翻译层是常驻端口，直接答 200。
  if (req.method === "HEAD" && path.endsWith("/api/hello")) {
    res.writeHead(200);
    res.end();
    return;
  }
  const m = /^\/t\/([^/]+)(?:\/s\/([^/]+))?\/v1\/messages(\/count_tokens)?$/.exec(path);
  if (req.method !== "POST" || !m) {
    console.warn(`[llm] 翻译层 404: ${req.method} ${req.url ?? ""}`);
    sse(res, 404, "not_found_error", "未知端点。");
    return;
  }
  const username = decodeURIComponent(m[1]);
  const sessionId = m[2] ? decodeURIComponent(m[2]) : null;
  if (m[3]) {
    // count_tokens：引擎拿它做上下文估算，给个保守近似即可。
    const raw = await readBody(req, 8 * 1024 * 1024).catch(() => "");
    const chars = raw.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 3) }));
    return;
  }
  // 客户端（引擎）断开 → 连带放弃上游请求由 fetch 的 signal 链路处理：
  // 翻译层没有独立的 abort 通道，流式循环随 res 关闭自然终止；借道中继时
  // 桥的 res close 会把 llm_cancel 转发给代发桌面。
  await handleMessages(username, sessionId, req, res);
}
