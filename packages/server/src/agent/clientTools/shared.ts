// Shared helpers for the client-machine MCP tool definitions.

import type { AttachmentImage } from "@blm/protocol";

export type RunAction = (
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<{
  ok: boolean;
  output?: string;
  error?: string;
  images?: AttachmentImage[];
}>;

export const CMD_TIMEOUT_MS = 120_000;
export const FILE_TIMEOUT_MS = 30_000;
export const BROWSER_TIMEOUT_MS = 180_000;

export function textResult(r: { ok: boolean; output?: string; error?: string }): {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
} {
  if (r.ok) {
    return { content: [{ type: "text", text: r.output || "(成功，无输出)" }] };
  }
  return {
    content: [{ type: "text", text: `操作失败：${r.error ?? "未知错误"}` }],
    isError: true,
  };
}

/**
 * Result for read_attachment: image mode returns the attachment's bytes as an
 * MCP image block (the model views it directly) plus a short text caption;
 * OCR mode is plain text and goes through textResult.
 */
export function attachmentResult(r: Awaited<ReturnType<RunAction>>): {
  content: (
    | { type: "image"; data: string; mimeType: string }
    | { type: "text"; text: string }
  )[];
  isError?: boolean;
} {
  if (!r.ok) {
    return {
      content: [{ type: "text", text: `读取附件失败：${r.error ?? "未知错误"}` }],
      isError: true,
    };
  }
  const content: (
    | { type: "image"; data: string; mimeType: string }
    | { type: "text"; text: string }
  )[] = [];
  for (const img of r.images ?? []) {
    content.push({ type: "image", data: img.data, mimeType: img.media_type });
  }
  if (r.output) content.push({ type: "text", text: r.output });
  if (content.length === 0) content.push({ type: "text", text: "(空文件)" });
  return { content };
}
