import { useState } from "react";
import type { Block } from "@blm/protocol";
import { useT } from "../../i18n";

// hover 复制按钮：点击写入剪贴板，短暂显示「已复制」。
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="del"
      style={{ position: "absolute", top: 4, right: 4, fontSize: 10, padding: "1px 6px", opacity: 0.75 }}
      title={t("chat.copy")}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      onMouseLeave={() => setCopied(false)}
    >
      {copied ? t("chat.copied") : t("chat.copy")}
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

function ToolResult({ block }: { block: Extract<Block, { kind: "tool_result" }> }): React.JSX.Element {
  return (
    <div style={{ position: "relative" }}>
      <div className={`tool-block ${block.is_error ? "error" : ""}`}>
        <AgentBadge block={block} />
        {block.is_error ? "⚠ " : "✓ "}
        {block.content.slice(0, 300)}
        {block.content.length > 300 ? "…" : ""}
      </div>
      <CopyButton text={block.content} />
    </div>
  );
}

export function MessageBlock({ block }: { block: Block }): React.JSX.Element {
switch (block.kind) {
case "user_text":
return <UserText text={block.text} />;
case "text":
return (
<div style={{ position: "relative" }}>
<div className="msg agent">{block.text}</div>
<CopyButton text={block.text} />
</div>
);
case "tool_call": {
const summary = delegateSummary(block);
return (
<div className="tool-block">
<AgentBadge block={block} />
🔧 {block.tool_name}
{summary ? <span style={{ opacity: 0.75 }}> — {summary}</span> : null}
</div>
);
}
case "tool_result":
return <ToolResult block={block} />;
}
}

// user_text with [附件] name → path lines: those render as chips, everything
// else stays plain text (same as before for messages without attachments).
function UserText({ text }: { text: string }): React.JSX.Element {
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
<span key={`a${i}`} className="attach-chip" title={m[2]}>
📎 {m[1]}
</span>,
);
} else {
plain += (plain || parts.length ? "\n" : "") + line;
}
});
if (plain) parts.push(<span key="plain-last">{plain}</span>);
return <div className="msg user">{parts}</div>;
}

export function StreamingMessage({ text }: { text: string }): React.JSX.Element {
return (
<div className="msg agent">
{text}
<span style={{ opacity: 0.5 }}>▍</span>
</div>
);
}
