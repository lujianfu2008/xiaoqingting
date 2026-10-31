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
