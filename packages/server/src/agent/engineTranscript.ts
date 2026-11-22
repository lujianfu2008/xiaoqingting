import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// 引擎转录手术：撤回消息时把「目标用户消息及其后全部条目」从引擎
// 自己的转录文件里裁掉。会话质量由转录决定（resume 时按它重建上下文），
// 只删服务端聊天记录治标不治本。转录是 uuid/parentUuid 链式 JSONL、
// 按时间追加，从目标条目起物理截尾 = 引擎自家的 checkpoint 回退同原理。
// 裁剪前先备份（backups/，按会话轮转保留最近 5 份），出错可手工恢复。
//
// 关键坑（实测）：引擎对转录的写是**延迟批量**的——回合结束后几十秒
// 才可能落盘；且 dispose 后引擎侧仍可能把它内存里的整份旧转录回写，
// 把裁掉的内容原样写回。所以手术后必须布置**自愈轮**：30 秒内多轮
// 复查，被撤文本一旦在裁剪边界之后复活就重裁（reset 场景则重删）。
// 自愈以「被撤文本」为签名，绝不误伤用户新发的正常内容。

export type TranscriptRecallOutcome =
  | "removed" // 裁剪成功，转录里仍有上下文，engine_session_id 保持不变
  | "reset" // 裁剪后转录里没有任何对话内容（撤的是第一条消息）：删文件，engine_session_id 一并清掉
  | "file_missing" // 转录文件本就不存在（引擎从未落盘/已被清理）：无上下文可保，清 engine_session_id 即可
  | "match_failed"; // 在转录里定位不到目标消息（如已被会话压缩折叠进摘要）：整个撤回拒绝，宁可不做

interface RecallRequest {
  engineSessionId: string;
  /** 目标是服务端历史里第几条用户消息（0 基）。 */
  ordinal: number;
  /** 服务端历史里 0..ordinal 各条用户消息的原文（含附件行），按序传入。 */
  blockTexts: string[];
}

interface Entry {
  line: string;
  obj: Record<string, unknown> | null;
}

/** 用户消息条目的正文（string content 或 text 片段拼接）；纯 tool_result 条目返回 null。 */
function promptText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "user" || obj.isSidechain === true) return null;
  const msg = obj.message as { content?: unknown } | undefined;
  if (!msg) return null;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let text = "";
    let hasToolResult = false;
    for (const part of c as Array<{ type?: string; text?: string }>) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
      if (part?.type === "tool_result") hasToolResult = true;
    }
    // 纯 tool_result 条目是引擎内部的工具回执，不是用户说的话。
    if (hasToolResult && text.trim() === "") return null;
    return text;
  }
  return null;
}

/** 定位转录文件：projects 的各子目录下按文件名找（文件名 = 引擎会话 id，
 *  实测全部一致）；找不到再兜底扫各文件首行的 sessionId。 */
function locateTranscript(engineSessionId: string): string | null {
  const projectsDir = path.join(config.engineHome, "projects");
  if (!fs.existsSync(projectsDir)) return null;
  for (const dir of fs.readdirSync(projectsDir)) {
    const f = path.join(projectsDir, dir, `${engineSessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  for (const dir of fs.readdirSync(projectsDir)) {
    const dd = path.join(projectsDir, dir);
    let st;
    try {
      st = fs.statSync(dd);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dd)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dd, f);
      try {
        const head = fs.readFileSync(full, "utf8").split("\n", 1)[0];
        const obj = JSON.parse(head) as { sessionId?: string };
        if (obj.sessionId === engineSessionId) return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** 裁剪前备份：backups/<id>.<时间戳>.jsonl.bak，按会话只留最近 5 份。 */
function backupTranscript(file: string, engineSessionId: string): void {
  const backupDir = path.join(config.engineHome, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(
    backupDir,
    `${engineSessionId}.${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.bak`,
  );
  fs.copyFileSync(file, dest);
  const mine = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(`${engineSessionId}.`) && f.endsWith(".bak"))
    .sort();
  while (mine.length > 5) fs.rmSync(path.join(backupDir, mine.shift()!), { force: true });
}

/**
 * 从转录里裁掉第 ordinal 条用户消息及其后全部条目。
 *
 * 定位算法：把服务端 0..ordinal 的用户消息与转录里的用户条目按序
 * 对齐着走——逐块在转录里找正文匹配的条目（先精确、后包含——斜杠
 * 呼叫的提示词是改写过的，原文包在里面），匹配后把紧随其后的同文
 * 条目一并吞掉（重新生成的复读条目，属于前一个块，不该算作后一个
 * 块的落点；下一块正文相同时不吞，连续重发同一文本不算复读）。
 * 走完 ordinal 个块即得截尾行号。
 */
export async function recallFromEngineTranscript(req: RecallRequest): Promise<TranscriptRecallOutcome> {
  const file = locateTranscript(req.engineSessionId);
  if (!file) return "file_missing";

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "file_missing";
  }
  const lines = raw.split("\n");
  const entries: Entry[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      obj = null; // 半行/损坏行：原样保留在原位，不参与匹配
    }
    entries.push({ line, obj });
  }
  const prompts: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const o = entries[i].obj;
    if (o && promptText(o) !== null) prompts.push(i);
  }

  let p = 0;
  let cutLine = -1;
  let targetTranscriptText = "";
  for (let j = 0; j < req.blockTexts.length; j++) {
    const want = req.blockTexts[j];
    if (want === undefined) return "match_failed";
    const strip = (s: string): string =>
      s
        .split("\n")
        .filter((l) => !/^\[附件\]\s*.+→/.test(l))
        .join("\n")
        .trim();
    const wantTrim = strip(want);
    const matchAt = (from: number): number => {
      for (let i = from; i < prompts.length; i++) {
        const t = promptText(entries[prompts[i]].obj!)!;
        if (t === want || strip(t) === wantTrim) return i;
        // 包含匹配兜底：斜杠改写的提示词把原文包在中间。只对
        // 非空原文做，且要求原文长度可观（太短的子串会误配）。
        if (wantTrim.length >= 12 && t.includes(wantTrim)) return i;
      }
      return -1;
    };
    const at = matchAt(p);
    if (at === -1) return "match_failed";
    p = at + 1;
    // 吞掉紧随其后的复读条目（重新生成对同一块的重发）。前瞻守卫：
    // 下一块的文本与本块相同时不吞——那是下一条消息的正文，不是复读，
    // 吞了会让目标块定位落空（连续重发同一文本的场景）。
    const matchedText = promptText(entries[prompts[at]].obj!)!;
    while (
      p < prompts.length &&
      promptText(entries[prompts[p]].obj!) === matchedText &&
      req.blockTexts[j + 1] !== matchedText
    ) {
      p++;
    }
    if (j === req.blockTexts.length - 1) {
      cutLine = prompts[at];
      // 自愈签名用转录侧实际落盘的文本（可能带引擎包装，与服务端
      // 块原文有出入）——保证延迟写回后按 includes 一定能认出来。
      targetTranscriptText = matchedText;
    }
  }
  if (cutLine < 0) return "match_failed";

  const kept0 = entries.slice(0, cutLine);
  // 目标回合的原始请求载荷（api-request-blob/队列条目）物理位置可能在
  // 目标 user 条目**之前**，且逐字嵌着被撤消息原文——留在保留区等于
  // 白裁。按签名把保留区里的这类行一并剔除（原文 + JSON 转义两种
  // 形态都查；更早回合的载荷不可能含本轮消息，无误伤）。
  const probe2 = JSON.stringify(targetTranscriptText).slice(1, -1);
  const probe3 = JSON.stringify(probe2).slice(1, -1);
  const kept = kept0.filter((e) => {
    if (!targetTranscriptText) return true;
    // 保留区的 user/assistant 条目绝不剔——那可能是早前的同文消息；
    // 签名剔除只针对引擎内部载荷行（请求转储/队列条目等）。载荷里
    // 的文本可能是原文、单层 JSON 转义（字段直存）或双层转义
    // （blob 字段嵌 JSON 字符串，实测存在），三形态都查。
    const t = e.obj?.type;
    if (t === "user" || t === "assistant") return true;
    return !(
      e.line.includes(targetTranscriptText) ||
      e.line.includes(probe2) ||
      e.line.includes(probe3)
    );
  });
  const hasConversation = kept.some((e) => {
    if (!e.obj) return false;
    return e.obj.type === "user" || e.obj.type === "assistant";
  });
  const targetNeedle = targetTranscriptText;

  backupTranscript(file, req.engineSessionId);
  if (!hasConversation) {
    // 撤的是第一条消息：转录里已无对话内容，整个文件删掉，
    // 引擎会话一并作废（调用方清 engine_session_id）。
    fs.rmSync(file, { force: true });
    scheduleHeal(file, [], targetNeedle);
    return "reset";
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, kept.map((e) => e.line).join("\n") + "\n");
  fs.renameSync(tmp, file);
  scheduleHeal(file, kept.map((e) => e.line), targetNeedle);
  return "removed";
}

// ---------- 术后自愈 ----------

// 复查节奏：引擎的延迟落盘实测可到回合结束后十几秒，覆盖到 30s。
const HEAL_DELAYS_MS = [1000, 4000, 9000, 16000, 25000];

/**
 * 布置术后自愈轮（后台，不阻塞撤回应答）。每轮读转录：
 * - removed 场景：被撤文本出现在 kept 边界之后 = 延迟落盘/退出回写
 *   把旧内容写回来了 → 按同样的边界重裁（边界之后的用户新内容一并
 *   裁掉——那只会是紧跟着旧回写出现的残留，正常新消息不含被撤文本）。
 * - reset 场景：文件复活且含被撤文本 → 再删（复活的新会话内容不含
 *   被撤文本时绝不碰——那是撤回后用户继续对话的合法新转录）。
 * 跑完全部轮次自然收工；定时器 unref，不拖服务器退出。
 */
function scheduleHeal(file: string, keptLines: string[], needle: string): void {
  if (needle.length === 0) return;
  const isReset = keptLines.length === 0;
  let round = 0;
  const tick = (): void => {
    round++;
    try {
      if (isReset) {
        if (!fs.existsSync(file)) return; // 删干净了（或没复活）→ 收工
        const content = fs.readFileSync(file, "utf8");
        if (content.includes(needle)) fs.rmSync(file, { force: true });
        return; // 复活的合法新内容不碰
      }
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      if (lines.length > keptLines.length) {
        const extra = lines.slice(keptLines.length).join("\n");
        if (extra.includes(needle)) {
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, lines.slice(0, keptLines.length).join("\n") + "\n");
          fs.renameSync(tmp, file);
        }
      }
    } catch {
      return; // 文件消失/读失败：无需再守
    }
    if (round < HEAL_DELAYS_MS.length) {
      const t = setTimeout(tick, HEAL_DELAYS_MS[round] - HEAL_DELAYS_MS[round - 1]);
      t.unref();
    }
  };
  const t = setTimeout(tick, HEAL_DELAYS_MS[0]);
  t.unref();
}
