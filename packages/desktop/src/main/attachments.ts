import { app, nativeImage } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Per-session local attachment store for files the user pasted/dragged into
// the message box (clipboard screenshots have no source path). Putting a
// file here is a user action, so read_attachment always allows paths inside.
export function attachmentsBase(): string {
return path.join(app.getPath("userData"), "attachments");
}

/** True when `p` is a file inside the attachment store (not the dir itself). */
export function isAttachmentPath(p: string): boolean {
const rel = path.relative(attachmentsBase(), path.resolve(p));
return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Files the user explicitly attached from their disk (drag/pick keep the
// original location; only clipboard saves land in the store). The renderer
// marks them at send time; like store files they are exempt from the read
// scope — an [附件] line is user intent, so a scope misconfig must not
// turn it into a denial. Runtime-only: clearing on app restart is fine,
// the same file can simply be attached again.
const marked = new Map<string, Set<string>>();

export function markAttachments(sessionId: string, paths: string[]): void {
if (!sessionId || paths.length === 0) return;
const set = marked.get(sessionId) ?? new Set<string>();
for (const p of paths) set.add(path.resolve(p));
marked.set(sessionId, set);
}

/** True when the user attached `p` to `sessionId` during this app run. */
export function isMarkedAttachment(sessionId: string | undefined, p: string): boolean {
if (!sessionId) return false;
return marked.get(sessionId)?.has(path.resolve(p)) ?? false;
}

/** Save bytes the renderer got from the clipboard; returns the absolute path. */
export async function saveAttachment(sessionId: string, bytes: Uint8Array, name: string): Promise<string> {
const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
const safe = name.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(-80) || "file";
const dir = path.join(attachmentsBase(), sid);
await fsp.mkdir(dir, { recursive: true });
const target = path.join(dir, `${crypto.randomUUID()}-${safe}`);
await fsp.writeFile(target, Buffer.from(bytes));
return target;
}

/** Small dataURL thumbnail for attachment chips; only serves the store dir. */
export function previewAttachment(p: string): { dataUrl?: string; error?: string } {
if (!isAttachmentPath(p)) return { error: "路径不在附件目录内" };
try {
const img = nativeImage.createFromPath(p);
if (img.isEmpty()) return { error: "不是有效图片" };
const { width } = img.getSize();
const small = width > 96 ? img.resize({ width: 96 }) : img;
return { dataUrl: small.toDataURL() };
} catch (e) {
return { error: (e as Error).message };
}
}
