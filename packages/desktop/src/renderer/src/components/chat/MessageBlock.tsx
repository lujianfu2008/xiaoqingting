import { useEffect, useRef, useState } from "react";
import type { Block } from "@blm/protocol";
import { useT } from "../../i18n";
import { flowEventText } from "../../lib/flowEvent";
import { Markdown } from "./markdown";
import { linkifyPaths, handleChipClick } from "../../lib/pathLinkify";
import { useStore } from "../../store";

// 写剪贴板：clipboard API 需要 https/localhost 安全上下文，
// Electron renderer 默认满足；不可用时降级 execCommand。
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// hover 复制按钮：点击写入剪贴板，短暂显示「已复制」；失败时
// 显示「复制失败」两秒（降级路径也失效的场景）。
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      className="msg-action"
      title={t("chat.copy")}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          } else {
            setFailed(true);
            window.setTimeout(() => setFailed(false), 2000);
          }
        });
      }}
      onMouseLeave={() => {
        setCopied(false);
        setFailed(false);
      }}
    >
      {copied ? t("chat.copied") : failed ? t("chat.copyFail") : t("chat.copy")}
    </button>
  );
}

// hover 重新生成按钮：对最后一条用户消息再跑一轮回复。
function RegenerateButton({
  disabled,
  onRegenerate,
}: {
  disabled: boolean;
  onRegenerate: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <button
      className="msg-action"
      title={disabled ? t("chat.regenerateBusy") : t("chat.regenerateTip")}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onRegenerate();
      }}
    >
      {t("chat.regenerate")}
    </button>
  );
}

// 子代理归属徽标：块由哪个子代理产生（主线程块无此字段，不渲染）。
function AgentBadge({ block }: { block: { agent_name?: string } }): React.JSX.Element | null {
if (!block.agent_name) return null;
return (
<span style={{ opacity: 0.85, marginRight: 4 }} title={block.agent_name}>
🤖 {block.agent_name}
</span>
);
}

// 委派调用的任务摘要：description 优先，没有用 prompt 截断。
function delegateSummary(block: Extract<Block, { kind: "tool_call" }>): string {
if (block.tool_name !== "delegate_task") return "";
const inp = typeof block.input === "object" && block.input !== null
? (block.input as { description?: unknown; prompt?: unknown })
: {};
const s = [inp.description, inp.prompt].find(
(v): v is string => typeof v === "string" && v.trim().length > 0,
);
if (!s) return "";
return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// 工具结果（工具输出纯文本）：路径 linkify 后同样可点进阅读器
// ——助手在正文里提到、或工具输出里出现（read_file/list_dir 的
// 输出、命令的打印等）的文件路径一律优先进内置阅读器。
// 只对成功结果做：错误输出里的路径多半是打错的，点了报错反而吵。
function ToolResult({ block }: { block: Extract<Block, { kind: "tool_result" }> }): React.JSX.Element {
  const openViewerFiles = useStore((s) => s.openViewerFiles);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    linkifyPaths(el, openViewerFiles);
  }, [block.content, openViewerFiles]);

  return (
    <div
      className="msg-wrap"
      onClick={(e) => {
        // 工具输出里的路径 chip：stat 校验后进阅读器。
        if (handleChipClick(e, openViewerFiles, t("vw.fileMissing"))) return;
      }}
    >
      <div className={`tool-block ${block.is_error ? "error" : ""}`} ref={block.is_error ? undefined : ref}>
        <AgentBadge block={block} />
        {block.is_error ? "⚠ " : "✓ "}
        {block.content.slice(0, 300)}
        {block.content.length > 300 ? "…" : ""}
      </div>
      <CopyButton text={block.content} />
    </div>
  );
}

// 任务清单（共享进度看板）：TodoWrite 的结构化渲染，取代 🔧 原始行。
function TaskList({ block }: { block: Extract<Block, { kind: "task_list" }> }): React.JSX.Element {
  const t = useT();
  return (
    <div className="tool-block">
      <AgentBadge block={block} />
      📋 {t("chat.taskList")}
      {block.items.map((it, i) => (
        <div
          key={i}
          style={{ marginTop: 2, opacity: it.status === "completed" ? 0.55 : 1 }}
        >
          {it.status === "completed" ? "✅" : it.status === "in_progress" ? "🔨" : "☐"}{" "}
          {it.status === "in_progress" ? <b>{it.content}</b> : it.content}
        </div>
      ))}
    </div>
  );
}

// 协作流事件行：谁把任务从什么环节推进到什么环节（任务线程时间线）。
// 文案生成在 lib/flowEvent（与 Markdown 导出共用，历史旧枚举块同表兼容）。
function FlowEventLine({ block }: { block: Extract<Block, { kind: "flow_event" }> }): React.JSX.Element {
  return (
    <div className="tool-block flow-event">
      {flowEventText(block)}
      {block.note ? <div style={{ opacity: 0.8, marginTop: 2 }}>💬 {block.note}</div> : null}
    </div>
  );
}

export function MessageBlock({
  block,
  showRegenerate,
  regenDisabled,
  onRegenerate,
}: {
  block: Block;
  /** 最后一条助手回复：回复下方显示「重新生成」。 */
  showRegenerate?: boolean;
  regenDisabled?: boolean;
  onRegenerate?: () => void;
}): React.JSX.Element {
switch (block.kind) {
case "user_text":
return <UserText text={block.text} />;
case "text":
return (
<div className="msg-wrap">
<div className="msg agent"><Markdown text={block.text} /></div>
<div className="msg-actions">
<CopyButton text={block.text} />
{showRegenerate && onRegenerate && (
<RegenerateButton disabled={regenDisabled === true} onRegenerate={onRegenerate} />
)}
</div>
</div>
);
case "tool_call": {
const summary = delegateSummary(block);
return (
<div className="tool-block">
<AgentBadge block={block} />
🔧 {block.tool_name}
{summary ? <span style={{ opacity: 0.75 }}> — {summary}</span> : null}
<ToolPathChip block={block} />
</div>
);
}
case "tool_result":
return <ToolResult block={block} />;
case "task_list":
return <TaskList block={block} />;
case "flow_event":
return <FlowEventLine block={block} />;
}
}

// user_text with [附件] name → path lines: those render as chips, everything
// else stays plain text (same as before for messages without attachments).
function UserText({ text }: { text: string }): React.JSX.Element {
  const openViewerFiles = useStore((s) => s.openViewerFiles);
  const parts: React.JSX.Element[] = [];
  let plain = "";
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^\[附件\]\s*(.+?)\s*→\s*(.+)$/);
    if (m) {
      if (plain) {
        parts.push(<span key={`p${i}`}>{plain}</span>);
        plain = "";
      }
      parts.push(
        <span
          key={`a${i}`}
          className="attach-chip clickable"
          title={`${m[2]}（点击在阅读器中查看）`}
          onClick={() => openViewerFiles([m[2]])}
        >
          📎 {m[1]}
        </span>,
      );
    } else {
      plain += (plain || parts.length ? "\n" : "") + line;
    }
  });
  if (plain) parts.push(<span key="plain-last">{plain}</span>);
  // 复制的是正文（附件行不复制——那些是路径，不是用户说的话）。
  const copyTextValue = text
    .split("\n")
    .filter((l) => !/^\[附件\]\s*.+→/.test(l))
    .join("\n")
    .trim();
  return (
    <div className="msg-wrap user-wrap">
      <div className="msg user">{parts}</div>
      <div className="msg-actions user-actions">
        <CopyButton text={copyTextValue} />
      </div>
    </div>
  );
}

// 工具调用的路径参数：读写文件类调用渲染可点的路径 chip，
// 点击在内置阅读器里查看（纯 UI 入口，路径不出本机）。
const PATH_CHIP_TOOLS = new Set(["read_file", "read_attachment", "write_file"]);

function ToolPathChip({ block }: { block: Extract<Block, { kind: "tool_call" }> }): React.JSX.Element | null {
  const openViewerFiles = useStore((s) => s.openViewerFiles);
  if (!PATH_CHIP_TOOLS.has(block.tool_name)) return null;
  const inp =
    typeof block.input === "object" && block.input !== null
      ? (block.input as { path?: unknown })
      : {};
  const p = typeof inp.path === "string" ? inp.path : "";
  if (!p) return null;
  return (
    <span
      className="attach-chip clickable"
      title={`${p}（点击在阅读器中查看）`}
      onClick={() => openViewerFiles([p])}
    >
      📄 {p.split(/[\\/]/).pop()}
    </span>
  );
}

export function StreamingMessage({ text }: { text: string }): React.JSX.Element {
return (
<div className="msg agent streaming">
<Markdown text={text} />
</div>
);
}
