import type { TextBlock } from "@blm/protocol";

// Extract the trailing emotion tag (`[情绪:开心]`) from a reply, keeping it
// out of the displayed text and TTS; it travels in TextBlock.emotion instead.
const EMOTION_RE = /\s*\[情绪[:：]([^\]]{1,8})\]\s*$/;

// Engine output that means the model credentials were rejected. The SDK
// surfaces some of these as ordinary assistant text rather than an exception.
const AUTH_FAILURE_RE =
  /\b401\b|API Error: 40[13]\b|invalid.?api.?key|authentication|unauthorized|Failed to authenticate/i;

// Only short engine-generated strings qualify — keeps ordinary replies that
// happen to mention "authentication" from turning into fake errors.
export function isAuthFailureText(text: string): boolean {
  const t = text.trim();
  return t.length <= 300 && AUTH_FAILURE_RE.test(t);
}

export function makeTextBlock(raw: string): TextBlock {
  const m = raw.match(EMOTION_RE);
  if (!m) return { kind: "text", text: raw.trim() };
  return { kind: "text", text: raw.slice(0, m.index).trimEnd(), emotion: m[1] };
}

export function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "object" && c !== null && (c as { type?: string }).type === "text") {
          return (c as { text?: string }).text ?? "";
        }
        // Image blocks (read_attachment in image mode): placeholder only —
        // never persist megabytes of base64 into the chat history.
        if (typeof c === "object" && c !== null && (c as { type?: string }).type === "image") {
          return "[图片]";
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

export const LLM_AUTH_ERROR_MESSAGE =
  "大模型鉴权失败，请在设置→我的大模型中检查 API Key、Base URL 与模型名。";
