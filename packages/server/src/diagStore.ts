import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { DiagResult } from "@blm/protocol";
import { config } from "./config.js";

// 显示诊断存档：管理页发起采集后，客户端回传的布局摘要/截图
// 落 data/diag/。保留最近 50 条（每条一个 .json，截图内嵌
// base64——与聊天附件同量级，不值得拆文件）。

const MAX_ENTRIES = 50;

function diagDir(): string {
  return path.join(config.dataDir, "diag");
}

export interface DiagStored {
  id: string;
  username: string;
  scope: "layout" | "screenshot";
  at: string;
  layout: DiagResult["layout"];
  screenshot?: { media_type: string; data: string };
}

export function storeDiagResult(username: string, result: DiagResult): void {
  const entry: DiagStored = {
    id: result.request_id,
    username,
    scope: result.screenshot ? "screenshot" : "layout",
    at: result.layout.at,
    layout: result.layout,
    ...(result.screenshot ? { screenshot: result.screenshot } : {}),
  };
  const dir = diagDir();
  fsp.mkdir(dir, { recursive: true })
    .then(() => fsp.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry)))
    .then(async () => {
      // 保留最近 MAX_ENTRIES 条（按 id 时间戳排序靠后的更新——
      // id 是 nextDiagId 的时间前缀，字典序即时间序）。
      const files = (await fsp.readdir(dir).catch(() => []))
        .filter((f) => f.endsWith(".json"))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - MAX_ENTRIES))) {
        await fsp.rm(path.join(dir, f)).catch(() => undefined);
      }
    })
    .catch(() => undefined);
}

export function listDiagEntries(): {
  id: string;
  username: string;
  scope: "layout" | "screenshot";
  at: string;
  has_screenshot: boolean;
}[] {
  const dir = diagDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.reverse()) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as DiagStored;
      out.push({
        id: e.id,
        username: e.username,
        scope: e.scope,
        at: e.at,
        has_screenshot: e.screenshot != null,
      });
    } catch {
      // corrupt entry — skip
    }
  }
  return out;
}

export function readDiagEntry(id: string): DiagStored | null {
  // id 只作文件名成分：白名单字符防路径穿越。
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(diagDir(), `${id}.json`), "utf8"),
    ) as DiagStored;
  } catch {
    return null;
  }
}

let diagSeq = 0;

/** 诊断请求 id：时间前缀（兼作存档排序键）+ 序号 + 随机尾。 */
export function nextDiagId(): string {
  const t = Date.now().toString(36);
  diagSeq = (diagSeq + 1) % 1000;
  return `d${t}${String(diagSeq).padStart(3, "0")}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
