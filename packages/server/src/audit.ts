import fs from "node:fs";
import path from "node:path";
import type { AuditEntry } from "@blm/protocol";
import { config } from "./config.js";

// Management-action audit trail: one JSON line per action in data/audit.jsonl.
// Append failures are logged and swallowed — auditing must never break the
// action it records. Rotation: when the file passes AUDIT_ROTATE_BYTES it is
// renamed to audit.jsonl.old (keeping one generation); reads beyond READ_TAIL
// bytes only look at the tail.

const AUDIT_FILE = "audit.jsonl";
const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;
const READ_TAIL_BYTES = 2 * 1024 * 1024;

// 条目形状（含 action 枚举）定义在 @blm/protocol，这里只做读写。

function auditPath(): string {
  return path.join(config.dataDir, AUDIT_FILE);
}

/** Append one entry; best-effort by design. */
export function appendAudit(entry: Omit<AuditEntry, "ts">): void {
  try {
    const file = auditPath();
    // Rotate before the file grows unbounded (cheap size check per append).
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) {
        fs.renameSync(file, file + ".old");
      }
    } catch {
      // missing file — nothing to rotate
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(file, line + "\n");
  } catch (err) {
    console.error("[audit] append failed:", err);
  }
}

/** Most recent entries, newest first. */
export function readRecentAudit(limit: number): AuditEntry[] {
  try {
    const file = auditPath();
    const stat = fs.statSync(file);
    let text: string;
    if (stat.size > READ_TAIL_BYTES) {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(READ_TAIL_BYTES);
        fs.readSync(fd, buf, 0, READ_TAIL_BYTES, stat.size - READ_TAIL_BYTES);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    } else {
      text = fs.readFileSync(file, "utf8");
    }
    const out: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (typeof parsed.ts === "string" && typeof parsed.action === "string") out.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return []; // no audit file yet
  }
}

/** 全部条目读取（用于删除/清空，不去 tail 截断）。 */
function readAllEntries(): AuditEntry[] {
  const file = auditPath();
  if (!fs.existsSync(file)) return [];
  const out: AuditEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed lines (kept positionally intact on rewrite)
    }
  }
  return out;
}

/** 重写整个审计文件（保留坏行位置给定语义：坏行当作不可删的占位保留）。 */
function rewriteAll(entries: AuditEntry[]): void {
  const file = auditPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""));
}

/** 按 ts+actor+action 精确匹配删除一条。返回是否删中（未命中 = false）。 */
export function deleteAuditEntry(match: { ts: string; actor: string; action: string }): boolean {
  const entries = readAllEntries();
  const idx = entries.findIndex(
    (e) => e.ts === match.ts && e.actor === match.actor && e.action === match.action,
  );
  if (idx < 0) return false;
  entries.splice(idx, 1);
  rewriteAll(entries);
  return true;
}

/** 清空全部审计条目。返回删除的条数。 */
export function clearAudit(): number {
  const n = readAllEntries().length;
  fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
  fs.writeFileSync(auditPath(), "");
  return n;
}
