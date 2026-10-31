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

// ---------- 网络中继（renderer -> main 的配置下发，token 只存 main 内存） ----------

/** renderer 登录后把 serverUrl + JWT 下发给 main 的 relay 连接用（内存持有）。
 * enabled=false 时凭证字段可为空（logout 只需断开）。 */
export const RelayConfigure = z.object({
  server_url: z.string().max(300),
  token: z.string().max(2048),
  enabled: z.boolean(),
});
export type RelayConfigure = z.infer<typeof RelayConfigure>;
