import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { isAttachmentPath, isMarkedAttachment } from "../attachments";
import { resolveReadable } from "./accessScope";
import { CMD_TIMEOUT_MS, MAX_OUTPUT, MAX_ATTACHMENT_BYTES, type ExecOutcome } from "./limits";
import { ocrImage } from "./ocr";
import { resolveSafe } from "./workdir";

// Command + file actions. Reads follow the access-scope policy (workspace
// always, wider when the user opted in); writes stay workspace-only.

const READ_DENIED = "路径不可读：不在访问范围内（可在设置中开启完全空间或添加自定义文件夹）。";
const WRITE_DENIED = "路径超出工作目录：写入/删除仅限工作目录内（工作目录之外只读）。";

export function runCommand(cmd: string, cwd: string): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env },
    });
    let out = "";
    let err = "";
    const cap = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...(输出已截断)" : s);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        output: cap(out + err),
        error: `命令执行超时（${CMD_TIMEOUT_MS / 1000}秒），已终止。`,
      });
    }, CMD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `命令启动失败：${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = cap(out) + (err ? `\n[stderr]\n${cap(err)}` : "");
      resolve({ ok: code === 0, output: text || undefined, error: code === 0 ? undefined : `命令退出码：${code}` });
    });
  });
}

export async function readFile(
  workDir: string,
  rawPath: string,
  projectId?: string | null,
): Promise<ExecOutcome> {
  const p = resolveReadable(workDir, rawPath, projectId);
  if (!p) return { ok: false, error: READ_DENIED };
  // Models keep trying to read_image with read_file — utf8 bytes are pure
  // noise. Steer to read_attachment instead of dumping mojibake into context.
  if (IMAGE_TYPES[path.extname(p).toLowerCase()]) {
    return {
      ok: false,
      error: "这是图片文件，read_file 只能读文本；请改用 read_attachment 工具读取图片。",
    };
  }
  try {
    const content = await fsp.readFile(p, "utf8");
    return { ok: true, output: content.slice(0, MAX_OUTPUT) };
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error).message}` };
  }
}

export async function writeFile(
  workDir: string,
  rawPath: string,
  content: string,
): Promise<ExecOutcome> {
  const p = resolveSafe(workDir, rawPath);
  if (!p) return { ok: false, error: WRITE_DENIED };
  try {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content, "utf8");
    return { ok: true, output: `已写入 ${p}` };
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error).message}` };
  }
}

export async function listDir(
  workDir: string,
  rawPath: string,
  projectId?: string | null,
): Promise<ExecOutcome> {
  const p = resolveReadable(workDir, rawPath, projectId);
  if (!p) return { ok: false, error: READ_DENIED };
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const lines = entries.map((e) => (e.isDirectory() ? `[目录] ${e.name}` : e.name));
    return { ok: true, output: lines.join("\n") || "(空目录)" };
  } catch (e) {
    return { ok: false, error: `列目录失败：${(e as Error).message}` };
  }
}

// ---------- attachments (read_attachment) ----------
const IMAGE_TYPES: Record<string, string> = {
".png": "image/png",
".jpg": "image/jpeg",
".jpeg": "image/jpeg",
".gif": "image/gif",
".webp": "image/webp",
};
const TEXT_EXTS = new Set([
".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py",
".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh",
".bat", ".cmd", ".ps1", ".sql", ".ini", ".cfg", ".conf", ".toml", ".log",
]);

/**
* Read a file the user attached to a message ([附件] line). Paths inside the
* app's attachment store are always readable (the user put them there on
* purpose); any other path still goes through the normal read scope.
*/
export async function readAttachment(
rawPath: string,
mode: "image" | "ocr",
workDir: string | null,
sessionId?: string,
projectId?: string | null,
): Promise<ExecOutcome> {
const abs = path.resolve(rawPath);
let size = 0;
try {
size = (await fsp.stat(abs)).size;
} catch {
return { ok: false, error: `文件不存在或不可访问：${abs}` };
}
if (size > MAX_ATTACHMENT_BYTES) {
return { ok: false, error: `附件过大（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB）。` };
}
// User intent: paths in the store and paths the user just attached are always
// readable; only agent-initiated paths go through the read scope.
if (!isAttachmentPath(abs) && !isMarkedAttachment(sessionId, abs)) {
if (!workDir || !resolveReadable(workDir, abs, projectId)) return { ok: false, error: READ_DENIED };
}
const ext = path.extname(abs).toLowerCase();
const imageType = IMAGE_TYPES[ext];
if (imageType && mode === "ocr") {
const r = await ocrImage(abs);
if (!r.ok) return r;
return { ok: true, output: `[图片文字识别结果 ${path.basename(abs)}]\n${r.output}` };
}
if (imageType) {
try {
const buf = await fsp.readFile(abs);
return {
ok: true,
output: `[图片文件 ${path.basename(abs)}]`,
images: [{ media_type: imageType, data: buf.toString("base64") }],
};
} catch (e) {
return { ok: false, error: `读取失败：${(e as Error).message}` };
}
}
if (TEXT_EXTS.has(ext) || !ext) {
try {
const content = await fsp.readFile(abs, "utf8");
return { ok: true, output: content.slice(0, MAX_OUTPUT) };
} catch (e) {
return { ok: false, error: `读取失败：${(e as Error).message}` };
}
}
return { ok: false, error: `暂不支持该格式（${ext || "无扩展名"}）的附件分析。` };
}
