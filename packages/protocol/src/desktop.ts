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

// ---------- 内置文件阅读器（renderer <-> main） ----------
// 只读预览本机文件：用户在 UI 里自己点的查看，与 agent 工具的
// read_file（accessScope 围栏 + 50k 截断）完全独立。打开的路径
// 绝不 markAttachments、绝不发服务端。

const ViewerPath = z.string().min(1).max(2048);

export const ViewerStatRequest = z.object({ path: ViewerPath });
export type ViewerStatRequest = z.infer<typeof ViewerStatRequest>;

export const ViewerListDirRequest = z.object({ path: ViewerPath });
export type ViewerListDirRequest = z.infer<typeof ViewerListDirRequest>;

export const ViewerReadRequest = z.object({
  path: ViewerPath,
  // 文本上限（字节）；省略 = main 侧默认 2MB。
  max_bytes: z.number().int().min(1).max(2 * 1024 * 1024).optional(),
});
export type ViewerReadRequest = z.infer<typeof ViewerReadRequest>;

export const ViewerEntry = z.object({
  path: z.string(),
  name: z.string(),
  is_dir: z.boolean(),
  size: z.number(),
  mtime_ms: z.number(),
});
export type ViewerEntry = z.infer<typeof ViewerEntry>;

export const ViewerListDirResult = z.object({
  entries: z.array(ViewerEntry).max(500),
  has_more: z.boolean(),
  error: z.string().optional(),
});
export type ViewerListDirResult = z.infer<typeof ViewerListDirResult>;

// 读响应 discriminated union：sniff 由 main 做（它手里有字节）。
// binary = NUL/控制字符占比超限（渲染层走「不支持预览→系统打开」）。
export const ViewerReadResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    encoding: z.enum(["utf8", "utf16le", "gbk"]),
    truncated: z.boolean(),
    total_bytes: z.number(),
  }),
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("too_large"), size: z.number(), max_bytes: z.number() }),
  z.object({ kind: z.literal("binary") }),
  z.object({ kind: z.literal("error"), error: z.string() }),
]);
export type ViewerReadResult = z.infer<typeof ViewerReadResult>;

export const ViewerOpenDialogResult = z.object({
  paths: z.array(z.string().min(1)).max(20),
});
export type ViewerOpenDialogResult = z.infer<typeof ViewerOpenDialogResult>;

export const ViewerStatResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    size: z.number(),
    mtime_ms: z.number(),
  }),
  z.object({ kind: z.literal("dir") }),
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("error"), error: z.string() }),
]);
export type ViewerStatResult = z.infer<typeof ViewerStatResult>;
