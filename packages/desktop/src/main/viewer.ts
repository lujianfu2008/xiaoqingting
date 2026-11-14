import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { uiStrings } from "./i18n";
import { loadSettings } from "./settings";
import {
  ViewerListDirRequest,
  ViewerListDirResult,
  ViewerOpenDialogResult,
  ViewerReadRequest,
  ViewerReadResult,
  ViewerStatRequest,
  ViewerStatResult,
} from "@blm/protocol";

// 内置文件阅读器的主进程半边：独立的只读通道 + viewer:// 二进制流协议。
//
// 安全边界（有意为之，勿"修复"）：本通道面向 UI（用户自己点的查看），
// 不走 agent 工具的 accessScope 围栏；renderer 本就是受信组件（blm:exec
// 可跑任意命令），此通道不扩大攻击面。打开的路径绝不 markAttachments、
// 绝不发给服务端——阅读器的内容不喂给 agent。

// 文本读取上限（字节）：2MB 内 IPC 传输几毫秒；超限由 UI 显示截断
// 提示并提供「用系统打开」逃生口。分块读暂不必要。
const MAX_VIEWER_BYTES = 2 * 1024 * 1024;
// 单层目录条目上限（node_modules 类大目录截断即可）。
const MAX_LIST_ENTRIES = 500;

/** 必须在 app ready 之前调用（index.ts 模块顶层）。 */
export function registerViewerPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "viewer",
      // secure: file:// 生产页与 http://localhost 开发页都把它当安全源，
      // 混合内容检查不拦；stream 支持流式 Response（媒体 Range）。
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

// ---------- viewer:// 路径编解码 ----------
// 整条路径放 pathname、host 固定 "local"——Windows 盘符冒号不能进
// host（host 里 : 是端口分隔符）。renderer 侧逐段 encodeURIComponent
// （见 renderer/src/lib/viewerUrl.ts），这里对应解码。

function pathFromViewerUrl(u: string): string {
  const p = decodeURIComponent(new URL(u).pathname); // "/C:/Users/a b.png"
  return process.platform === "win32" ? path.normalize(p.slice(1)) : p;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
};

const isMedia = (ext: string): boolean =>
  [".mp4", ".webm", ".mkv", ".mov", ".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext);

/** app ready 后调用：注册 viewer:// handler 与全部 IPC。 */
export function registerViewerIpc(): void {
  protocol.handle("viewer", async (req) => {
    try {
      const abs = pathFromViewerUrl(req.url);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || st.isDirectory()) return new Response(null, { status: 404 });
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      // 音视频必须自实现 Range 206：net.fetch(file://) 不透传 Range，
      // stream: true 只是允许流式 Response，不会替我们切。
      const range = req.headers.get("range");
      if (range && isMedia(ext)) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const size = st.size;
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
          if (start <= end && start < size) {
            const stream = fs.createReadStream(abs, { start, end });
            return new Response(Readable.toWeb(stream) as ReadableStream, {
              status: 206,
              headers: {
                "Content-Type": mime,
                "Content-Length": String(end - start + 1),
                "Content-Range": `bytes ${start}-${end}/${size}`,
                "Accept-Ranges": "bytes",
              },
            });
          }
        }
      }
      // file URL 必须经 pathToFileURL 拼（Windows 盘符要 file:///C:/ 三斜杠）。
      return await net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  // ---------- IPC（renderer-only，绝不在 WS action 枚举里） ----------

  ipcMain.handle("blm:viewer:stat", async (_e, args: unknown): Promise<ViewerStatResult> => {
    const parsed = ViewerStatRequest.safeParse(args);
    if (!parsed.success) return { kind: "error", error: "无效请求" };
    try {
      const st = await fsp.stat(parsed.data.path);
      if (st.isDirectory()) return { kind: "dir" };
      return { kind: "file", size: st.size, mtime_ms: st.mtimeMs };
    } catch {
      return { kind: "missing" };
    }
  });

  ipcMain.handle(
    "blm:viewer:listDir",
    async (_e, args: unknown): Promise<ViewerListDirResult> => {
      const parsed = ViewerListDirRequest.safeParse(args);
      if (!parsed.success) return { entries: [], has_more: false, error: "无效请求" };
      const p = parsed.data.path;
      try {
        const dirents = await fsp.readdir(p, { withFileTypes: true });
        // 目录优先、同类型按名排序；超限截断（has_more 提示）。
        dirents.sort((a, b) =>
          a.isDirectory() !== b.isDirectory()
            ? a.isDirectory() ? -1 : 1
            : a.name.localeCompare(b.name),
        );
        const shown = dirents.slice(0, MAX_LIST_ENTRIES);
        const entries = await Promise.all(
          shown.map(async (d) => {
            const full = path.join(p, d.name);
            try {
              const st = await fsp.stat(full);
              return { path: full, name: d.name, is_dir: d.isDirectory(), size: st.size, mtime_ms: st.mtimeMs };
            } catch {
              return { path: full, name: d.name, is_dir: d.isDirectory(), size: 0, mtime_ms: 0 };
            }
          }),
        );
        return { entries, has_more: dirents.length > MAX_LIST_ENTRIES };
      } catch (e) {
        return { entries: [], has_more: false, error: `列目录失败：${(e as Error).message}` };
      }
    },
  );

  ipcMain.handle("blm:viewer:read", async (_e, args: unknown): Promise<ViewerReadResult> => {
    const parsed = ViewerReadRequest.safeParse(args);
    if (!parsed.success) return { kind: "error", error: "无效请求" };
    return readTextFile(parsed.data.path, parsed.data.max_bytes ?? MAX_VIEWER_BYTES);
  });

  // 「打开文件」：首个 openFile（非 openDirectory）dialog 先例。
  ipcMain.handle("blm:viewer:openDialog", async (): Promise<ViewerOpenDialogResult> => {
    const r = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    return { paths: r.canceled ? [] : r.filePaths };
  });

  // 不支持预览的格式交给系统默认程序（shell 而非 openExternal——本地路径）。
  ipcMain.handle("blm:viewer:openExternal", (_e, p: unknown) => {
    if (typeof p !== "string" || !p) return { error: "无效请求" };
    return shell.openPath(p).then((err) => (err ? { error: err } : {}));
  });

  // 阅读器弹窗：独立窗口看单个文件（参照浏览器 pane 的「弹窗」）。
  // 弹窗加载同一 renderer 页 + hash 路由，渲染端按 path 直接渲染
  // viewer 组件，不依赖主窗状态。
  ipcMain.handle("blm:viewer:popOut", (_e, p: unknown) => {
    if (typeof p !== "string" || !p) return { error: "无效请求" };
    const name = path.basename(p);
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      title: `${name} — ${uiStrings(loadSettings().language).viewerTitle}`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const hash = `#viewer-popup?path=${encodeURIComponent(p)}`;
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
    } else {
      void win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
    }
    return {};
  });
}

// ---------- 文本嗅探与解码（BOM → utf8 → GBK → binary） ----------
// GBK 兜底全平台启用：与 executor fileOps 的 win32-only 先例不同——
// 那里是控制台管道编码问题，这里是文件内容本身（同事发来的 GBK 文档
// 与平台无关）；Electron 全量 ICU 下 TextDecoder("gbk") 任何平台可用。

async function readTextFile(p: string, maxBytes: number): Promise<ViewerReadResult> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(p);
  } catch (e) {
    return { kind: "error", error: `无法读取：${(e as Error).message}` };
  }
  if (st.isDirectory()) return { kind: "error", error: "这是一个目录" };
  if (st.size === 0) return { kind: "empty" };
  if (st.size > maxBytes) return { kind: "too_large", size: st.size, max_bytes: maxBytes };

  let buf: Buffer;
  try {
    buf = await fsp.readFile(p);
  } catch (e) {
    return { kind: "error", error: `无法读取：${(e as Error).message}` };
  }
  // 长度取读到的实际字节数（TOCTOU 窗口里文件可能变大）。
  const total = Math.min(buf.length, st.size);

  // BOM 探测（确定性编码）。
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return textResult(buf.toString("utf8").slice(1), "utf8", total, maxBytes);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return textResult(buf.toString("utf16le").slice(1), "utf16le", total, maxBytes);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE 手工交换成 LE 再解。
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return textResult(sw.toString("utf16le"), "utf16le", total, maxBytes);
  }

  // 无 BOM：utf8 strict 试探（8KB 样本足够判定），NUL 占比超限
  // 判二进制（NUL 是合法 utf8——纯零字节文件不能当文本展示），
  // 其余 → GBK 全解，GBK 结果乱码占比仍高 → 判二进制。
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls++;
  if (nuls / Math.max(sample.length, 1) > 0.01) return { kind: "binary" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return textResult(buf.toString("utf8"), "utf8", total, maxBytes);
  } catch {
    // fall through to GBK
  }
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    const bad = (gbk.match(/\uFFFD/g) ?? []).length;
    if (bad / Math.max(gbk.length, 1) <= 0.01) {
      return textResult(gbk, "gbk", total, maxBytes);
    }
  } catch {
    // 无 full-ICU 时 TextDecoder("gbk") 抛错 → binary
  }
  return { kind: "binary" };
}

function textResult(
  text: string,
  encoding: "utf8" | "utf16le" | "gbk",
  totalBytes: number,
  maxBytes: number,
): ViewerReadResult {
  // 按字符截断到字节预算内（上限余量防止单字符越界）。
  const maxChars = Math.floor(maxBytes / 4);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { kind: "text", text, encoding, truncated, total_bytes: totalBytes };
}
