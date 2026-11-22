import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getEnabledLlmProfiles,
  getUserLlmSettings,
  type ResolvedProfile,
} from "./llmConfig.js";
import { relayBorrowUrlFor } from "./relay/llmBridge.js";

// 个人大模型适配层：引擎的个人配置流量统一过本端口，对引擎而言这是标准的
// Anthropic 端点（流式回 Anthropic SSE，非流式回 Anthropic message JSON，
// 错误回 Anthropic error JSON）。两条路线按「当前生效配置」的协议选择：
//
//   /a/<user>[/s/<session>]/<原路径>   Anthropic 协议：请求原样透传（改写模型）
//   /t/<user>[/s/<session>]/v1/messages  OpenAI 协议：翻译成 chat/completions
//
// 多配置择优（超时/重试/自动切换都在这层实现）：候选 = 按优先级排序的启用
// 配置（自动模型选择关掉时只取第一条）。每个候选先按 settings.retries 重试
// 可重试失败（超时/网络错误/5xx/429），仍不行就自动切换下一个候选；鉴权类
// 错误（401/403/400/404）不耗重试直接换下一家。流式响应一旦开始吐字就不再
// 切换（只按空闲超时收尾报错）。
//
// 上游出网优先借中继入口（/g 显式目标路由，每个候选网关地址不同），无人可借
// 时服务端直连。鉴权在服务端按候选注入（存储的个人 key），引擎带来的认证头
// 一律忽略——切到别的配置时引擎那把 key 不再对应真实目标。

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

// ---------- 上游出网与候选择优 ----------

/** 可重试的失败：超时（fetch 抛错）/网络抖动/服务端过载。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** 候选列表：按优先级的启用配置；自动模型选择关闭时只取第一条。 */
function candidateList(username: string): ResolvedProfile[] {
  const enabled = getEnabledLlmProfiles(username);
  if (enabled.length === 0) return [];
  return getUserLlmSettings(username).auto_select ? enabled : enabled.slice(0, 1);
}

/** 上游地址：优先借中继入口（/g 显式目标路由——每个候选网关地址不同），
 *  无人可借（中继关/无人 opt-in/桌面全离线）则服务端直连。≥1 台桌面在线时
 *  必须借——桌面离线时要直连（2026-11-02 的坑：桥端口常年监听，但桌面离线
 *  时桥回 503，不先判在线等于把可直连的网关永久打成不可用）。 */
function upstreamFor(
  username: string,
  sessionId: string | null,
  profile: ResolvedProfile,
  enginePath: string,
): { url: string; viaRelay: boolean } | null {
  let base = profile.base_url?.trim().replace(/\/+$/, "") ?? "";
  if (!base && profile.protocol !== "openai") base = "https://api.anthropic.com";
  if (!base) return null;
  const borrow = relayBorrowUrlFor(username, sessionId, base);
  if (borrow) return { url: `${borrow}${enginePath}`, viaRelay: true };
  return { url: `${base}${enginePath}`, viaRelay: false };
}

/** 按候选注入请求头：认证一律服务端说了算，引擎带来的认证头忽略。 */
function authHeadersFor(
  profile: ResolvedProfile,
  incoming: IncomingMessage["headers"],
): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (typeof incoming.accept === "string") h.accept = incoming.accept;
  if (profile.protocol === "openai") {
    if (profile.api_key) h.authorization = `Bearer ${profile.api_key}`;
  } else {
    h["x-api-key"] = profile.api_key ?? "";
    h["anthropic-version"] =
      typeof incoming["anthropic-version"] === "string"
        ? incoming["anthropic-version"]
        : "2023-06-01";
    if (typeof incoming["anthropic-beta"] === "string") {
      h["anthropic-beta"] = incoming["anthropic-beta"];
    }
  }
  return h;
}

interface CandidateFailure {
  kind: "fail";
  retryable: boolean;
  /** 0 = 网络/超时类失败（无 HTTP 状态）。 */
  status: number;
  message: string;
}
interface CandidateSuccess {
  kind: "ok";
  res: Response;
  /** 空闲看门狗：流式阶段每收到一片续期；abort 即「上游停摆/网络断」。 */
  idle: AbortController;
}
type CandidateOutcome =
  | CandidateSuccess
  | CandidateFailure
  | { kind: "aborted" }; // 引擎侧断开（用户点停止）——整链放弃

/**
 * 构造单次尝试的 opener。bodies 可给两个变体（带/不带 stream_options）：
 * 个别网关不认 stream_options，400/422 时用第二个变体立即补一发（不耗重试
 * 次数）。超时语义：等响应头最多 timeout_ms；信号同时挂在 fetch 上，响应
 * 阶段由 commit 的空闲看门狗续期，不会把长流一刀切。
 */
function makeAttempt(
  upstreamUrl: string,
  headers: Record<string, string>,
  bodies: string[],
  upstreamAbort: AbortController,
  timeoutMs: number,
): () => Promise<CandidateOutcome> {
  return async () => {
    const idle = new AbortController();
    const arm = (): NodeJS.Timeout =>
      setTimeout(
        () => idle.abort(new Error(`上游 ${timeoutMs / 1000} 秒无响应`)),
        timeoutMs,
      );
    let timer = arm();
    let body = bodies[0];
    let altTried = false;
    try {
      for (;;) {
        const res = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.any([upstreamAbort.signal, idle.signal]),
        });
        if (res.ok) {
          clearTimeout(timer);
          return { kind: "ok", res, idle };
        }
        if (
          !altTried &&
          bodies.length > 1 &&
          (res.status === 400 || res.status === 422)
        ) {
          // 换无 stream_options 变体立即重试一次
          altTried = true;
          body = bodies[1];
          clearTimeout(timer);
          timer = arm();
          void res.text().catch(() => {});
          continue;
        }
        const text = await res.text().catch(() => "");
        clearTimeout(timer);
        return {
          kind: "fail",
          retryable: RETRYABLE_STATUS.has(res.status),
          status: res.status,
          message: text.slice(0, 500) || `上游返回 ${res.status}`,
        };
      }
    } catch (err) {
      clearTimeout(timer);
      if (upstreamAbort.signal.aborted) return { kind: "aborted" };
      return {
        kind: "fail",
        retryable: true,
        status: 0,
        message: (err as Error).message || "上游请求失败",
      };
    }
  };
}

/** 单候选完整尝试：retries+1 次，可重试失败耗尽后返回最后一次失败。 */
async function runForCandidate(
  attempt: () => Promise<CandidateOutcome>,
  retries: number,
  label: string,
): Promise<CandidateOutcome> {
  let last: CandidateFailure = {
    kind: "fail",
    retryable: false,
    status: 0,
    message: "未尝试",
  };
  for (let i = 0; i <= retries; i++) {
    const out = await attempt();
    if (out.kind !== "fail") return out;
    last = out;
    console.warn(
      `[llm] ${label} 第 ${i + 1}/${retries + 1} 次尝试失败：${out.status || "网络/超时"} ${out.message.slice(0, 200)}`,
    );
    if (!out.retryable) break;
  }
  return last;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 交付已成功的上游响应给引擎（commit 起不再切换候选）。流式阶段用空闲看门狗
 * ——停摆超过 timeout_ms 就断开收尾；非流式同限内读完。
 */
async function commitResponse(
  success: CandidateSuccess,
  res: ServerResponse,
  opts: { translate: boolean; model: string; stream: boolean; timeoutMs: number; label: string },
): Promise<void> {
  const { res: upstreamRes, idle } = success;
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle.abort(new Error(`流空闲超时（${opts.timeoutMs / 1000} 秒无数据）`));
    }, opts.timeoutMs);
    idleTimer.unref();
  };
  armIdle();
  const stopIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const decoder = new TextDecoder("utf-8");

  if (!opts.stream) {
    // 非流式：一次性读体（超时由 idle 看门狗兜底）
    try {
      if (opts.translate) {
        const data = (await upstreamRes.json()) as OpenAiResponse;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(openAiResponseToAnthropic(data, opts.model)));
      } else {
        const text = await upstreamRes.text();
        res.writeHead(200, {
          "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      }
    } catch (err) {
      stopIdle();
      if (res.destroyed) return; // 引擎侧已断开（点停止），静默收尾
      sse(res, 502, "api_error", `读取上游响应失败：${(err as Error).message}`);
    }
    stopIdle();
    return;
  }

  // 流式：SSE → 引擎（translate 路线经翻译器；透传路线原样转发）
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const translator = opts.translate ? new OpenAiStreamTranslator(opts.model) : null;
  try {
    for await (const c of upstreamRes.body ?? []) {
      armIdle(); // 每片续期
      const chunk = decoder.decode(c as Buffer, { stream: true });
      const out = translator ? translator.push(chunk) : chunk;
      if (out) res.write(out);
    }
    const tail = translator
      ? translator.push(decoder.decode()) + translator.end()
      : decoder.decode();
    res.write(tail);
  } catch (err) {
    // 流中断/空闲停摆：按 Anthropic error 事件收尾（引擎按 API 错误处理）。
    stopIdle();
    console.warn(`[llm] ${opts.label} 流中断：${(err as Error).message}`);
    const pre = translator ? translator.end() : "";
    res.write(
      pre +
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `流中断：${(err as Error).message}` },
        })}\n\n`,
    );
  }
  stopIdle();
  res.end();
}

/**
 * 个人配置请求统一处置：按候选择优（超时→重试→自动切换）。候选若是 OpenAI
 * 协议则翻译成 chat/completions（上游路径 /chat/completions），Anthropic
 * 协议则透传（上游路径 = 引擎原始路径）——引擎侧输出格式始终是 Anthropic，
 * 跨协议切换对引擎透明。
 */
async function handleEngineRequest(
  username: string,
  sessionId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { anthropicPath: string; translate: boolean },
): Promise<void> {
  const candidates = candidateList(username);
  if (candidates.length === 0) {
    sse(res, 401, "authentication_error", "未配置个人大模型，请先在设置「我的大模型」里添加并启用一条配置。");
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
  const settings = getUserLlmSettings(username);
  // 引擎侧断开（点停止）→ 连带 abort 上游整链。
  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort());

  let lastFail: CandidateFailure | null = null;
  for (let ci = 0; ci < candidates.length; ci++) {
    const profile = candidates[ci];
    const skip = (message: string): void => {
      lastFail = { kind: "fail", retryable: false, status: 400, message };
      console.warn(`[llm] 候选「${profile.name}」跳过：${message}`);
    };
    const model = profile.model?.trim() || body.model || "";
    if (!model) {
      skip("未填模型名");
      continue;
    }
    if (!profile.api_key) {
      skip("未填 API Key");
      continue;
    }
    const translate = profile.protocol === "openai";
    const upstreamPath = translate ? "/chat/completions" : opts.anthropicPath;
    const upstream = upstreamFor(username, sessionId, profile, upstreamPath);
    if (!upstream) {
      skip("OpenAI 协议需要在配置里填写 base_url");
      continue;
    }
    const label = `候选 ${ci + 1}/${candidates.length}「${profile.name}」`;
    console.info(
      `[llm] ${username} model=${model} → ${label}(${translate ? "openai" : "anthropic"}) ` +
        `${upstream.viaRelay ? "中继桥代发" : "直连"} ${hostOf(upstream.url)}${upstreamPath.split("?")[0]}`,
    );

    // 请求体按候选准备：模型改写 + 协议翻译。流式请求备两个变体（带/不带
    // stream_options）；非流式只有一个形态。
    const effective = model !== body.model ? { ...body, model } : body;
    const openaiBody = translate ? anthropicToOpenAiRequest(effective, model) : null;
    const bodies = openaiBody
      ? openaiBody.stream
        ? [
            JSON.stringify({ ...openaiBody, stream_options: { include_usage: true } }),
            JSON.stringify(openaiBody),
          ]
        : [JSON.stringify(openaiBody)]
      : [JSON.stringify(effective)];

    const attempt = makeAttempt(
      upstream.url,
      authHeadersFor(profile, req.headers),
      bodies,
      upstreamAbort,
      settings.timeout_ms,
    );
    const outcome = await runForCandidate(attempt, settings.retries, label);
    if (outcome.kind === "aborted") {
      res.destroy();
      return;
    }
    if (outcome.kind === "ok") {
      await commitResponse(outcome, res, {
        translate,
        model,
        stream: body.stream === true,
        timeoutMs: settings.timeout_ms,
        label,
      });
      return;
    }
    lastFail = outcome;
    if (ci < candidates.length - 1) {
      console.warn(
        `[llm] ${label} 失败（${outcome.status || "网络/超时"}）→ 自动切换下一个配置`,
      );
    }
  }

  const f = lastFail ?? { kind: "fail" as const, retryable: false, status: 502, message: "无可用配置" };
  const status = f.status || 502;
  sse(
    res,
    status,
    errorTypeForStatus(status),
    `所有已启用的大模型配置均失败（最后错误：${f.message}）`,
  );
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
      console.info(`[llm] 个人大模型适配层已就绪 port=${compatPort}`);
      resolve();
    });
  });
}

async function handleCompatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 只回答两条前缀，其余一律 Anthropic 404。引擎 CLI 实际请求带查询参数
  // （v1/messages?beta=true）——路由前必须剥掉再透传回去。session 可缺省
  // （老会话的 base_url 没有它）：缺省时负责人解析退化为「只用会话主人」。
  const rawUrl = req.url ?? "";
  const q = rawUrl.indexOf("?");
  const path = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const query = q >= 0 ? rawUrl.slice(q) : "";
  // SDK 对引擎 base 做探活（HEAD <base>/api/hello）：翻译层是常驻端口，直接答 200。
  if (req.method === "HEAD" && path.endsWith("/api/hello")) {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    console.warn(`[llm] 适配层 404: ${req.method} ${rawUrl}`);
    sse(res, 404, "not_found_error", "未知端点。");
    return;
  }
  const tm = /^\/t\/([^/]+)(?:\/s\/([^/]+))?\/v1\/messages(\/count_tokens)?$/.exec(path);
  if (tm) {
    const username = decodeURIComponent(tm[1]);
    const sessionId = tm[2] ? decodeURIComponent(tm[2]) : null;
    if (tm[3]) {
      // count_tokens：OpenAI 网关没有这个端点，本地按字符数给保守近似即可。
      const raw = await readBody(req, 8 * 1024 * 1024).catch(() => "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 3) }));
      return;
    }
    await handleEngineRequest(username, sessionId, req, res, {
      anthropicPath: "/v1/messages" + query,
      translate: true,
    });
    return;
  }
  const am = /^\/a\/([^/]+)(?:\/s\/([^/]+))?(\/.+)$/.exec(path);
  if (am) {
    const username = decodeURIComponent(am[1]);
    const sessionId = am[2] ? decodeURIComponent(am[2]) : null;
    await handleEngineRequest(username, sessionId, req, res, {
      anthropicPath: am[3] + query,
      translate: false,
    });
    return;
  }
  console.warn(`[llm] 适配层 404: ${req.method} ${rawUrl}`);
  sse(res, 404, "not_found_error", "未知端点。");
}
