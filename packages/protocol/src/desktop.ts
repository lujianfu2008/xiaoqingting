import { z } from "zod";

// ---------- Desktop: renderer <-> main process (IPC) ----------

// Export one chat session to a Markdown file via the native save dialog.
// The markdown is rendered in the renderer; the main process only writes it.
export const ExportChatRequest = z.object({
  default_filename: z.string().min(1).max(200),
  markdown: z.string().max(20 * 1024 * 1024),
});
export type ExportChatRequest = z.infer<typeof ExportChatRequest>;

export const ExportChatResult = z.object({
  saved: z.boolean(),
  path: z.string().nullable(),
});
export type ExportChatResult = z.infer<typeof ExportChatResult>;
