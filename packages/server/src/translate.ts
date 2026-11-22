import { config } from "./config.js";
import { getUserLlmConfig } from "./llmConfig.js";
import { relayIngressFor } from "./relay/llmBridge.js";
import { openaiCompatBaseFor } from "./openaiCompat.js";

// 市场描述翻译（官方目录全英文）：把一批短文本经 LLM 译成中文。调用链路与
// 会话同源——openai 协议走翻译层（鉴权服务端注入），否则走中继入口借桌面
// 代发（搜市场的人桌面必然在线），都不可用再直连；没有个人配置就用服务器
// 默认模型。结果进程内缓存（描述基本不变），失败一律回原文，搜索永不变慢死。

const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 800;
const CACHE_TRIM_TO = 600;
const CALL_TIMEOUT_MS = 20_000;

const cache = new Map<string, { text: string; at: number }>();

function trimCache(): void {
  if (cache.size <= CACHE_MAX) return;
  const drop = [...cache.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, cache.size - CACHE_TRIM_TO);
  for (const [k] of drop) cache.delete(k);
}

const SYSTEM_PROMPT =
  "你是界面文案翻译。把用户消息里 JSON 数组的每个英文条目（MCP 服务器/技能的描述）翻译成简体中文，" +
  "保留专有名词（产品名、协议名、域名、命令）原样。只输出一个与输入等长的 JSON 字符串数组，不要输出任何其他内容。";

/** 单次 Messages 调用（非流式），返回首段文本；任何失败返回 null。 */
async function callLlm(
  username: string,
  userText: string,
  maxTokens: number,
): Promise<string | null> {
  const llm = getUserLlmConfig(username);
  const apiKey = llm?.api_key ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const model = llm?.model ?? process.env.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!apiKey || !model) return null;
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  // openai 协议 → 翻译层（鉴权它注入，引擎带来的认证头被忽略）；其余 →
  // 中继入口借桌面代发；入口不可用 → 直连（字符串拼接，new URL 会丢 base 路径）。
  const compat = llm?.protocol === "openai" ? openaiCompatBaseFor() : null;
  const ingress = compat ? null : relayIngressFor(username, null);
  let url: string;
  if (compat) {
    url = `${compat}/t/${encodeURIComponent(username)}/v1/messages`;
  } else if (ingress) {
    url = `${ingress}/v1/messages`;
  } else {
    const base = (llm?.base_url ?? process.env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "");
    if (!base) return null;
    url = `${base}/v1/messages`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = j.content?.find((c) => c.type === "text")?.text;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/**
 * 批量翻译成中文：命中缓存的直接用，未命中的合并成一次 LLM 调用，解析失败
 * 的条目保留原文。返回与输入等长的数组（顺序一致），永不为翻译而抛错。
 */
export async function translateToZh(
  username: string,
  texts: string[],
): Promise<string[]> {
  const out: string[] = [];
  const misses: { idx: number; text: string }[] = [];
  const now = Date.now();
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i];
    const hit = cache.get(raw);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      hit.at = now;
      out[i] = hit.text;
    } else {
      out[i] = raw;
      if (raw.trim()) misses.push({ idx: i, text: raw });
    }
  }
  if (misses.length === 0) return out;
  const reply = await callLlm(
    username,
    JSON.stringify(misses.map((m) => m.text)),
    200 * misses.length + 200,
  );
  if (reply) {
    try {
      const parsed: unknown = JSON.parse(reply);
      if (Array.isArray(parsed)) {
        misses.forEach((m, i) => {
          const t = parsed[i];
          if (typeof t === "string" && t.trim()) {
            out[m.idx] = t;
            cache.set(m.text, { text: t, at: Date.now() });
          }
        });
        trimCache();
      }
    } catch {
      // 模型输出不合规：整批保留原文
    }
  }
  return out;
}
