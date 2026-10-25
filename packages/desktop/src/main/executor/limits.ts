// Output caps shared by the local executor actions.
export const CMD_TIMEOUT_MS = 90_000;
export const MAX_OUTPUT = 50_000; // chars
export const MAX_PAGE_TEXT = 20_000;
// Attachment (read_attachment) size cap: keeps the base64 copy well within
// WS frame limits on both hops (client→server, server→engine).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ExecOutcome {
ok: boolean;
output?: string;
error?: string;
// Base64 images (read_attachment in image mode) — forwarded to the engine
// as MCP image content blocks.
images?: { media_type: string; data: string }[];
}
