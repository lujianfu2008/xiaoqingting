import { useState } from "react";
import type { Block, FlowAction, TaskStatus } from "@blm/protocol";
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

// 协作流状态/动作的中文标签（FlowBar 与事件行共用）。
export const FLOW_STATUS_LABEL: Record<TaskStatus, string> = {
  analyzing: "需求分析",
  developing: "研发中",
  fixing: "修复中",
  testing: "测试中",
  done: "已完成",
};
export const FLOW_ACTION_LABEL: Record<FlowAction, string> = {
  assign_dev: "指派研发",
  submit_test: "提交测试",
  assign_tester: "指派测试",
  report_issue: "反馈问题",
  resubmit: "重新提测",
  pass: "测试通过",
  cancel: "取消任务",
};

// 协作流事件行：谁把任务从什么状态推进到什么状态（任务线程时间线）。
function FlowEventLine({ block }: { block: Extract<Block, { kind: "flow_event" }> }): React.JSX.Element {
  const targets = block.targets?.length ? ` → ${block.targets.join("、")}` : "";
  return (
    <div className="tool-block flow-event">
      🔄 {block.actor} {FLOW_ACTION_LABEL[block.action]}
      {targets}（{FLOW_STATUS_LABEL[block.from_status]} → {FLOW_STATUS_LABEL[block.to_status]}）
      {block.note ? <div style={{ opacity: 0.8, marginTop: 2 }}>💬 {block.note}</div> : null}
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
case "task_list":
return <TaskList block={block} />;
case "flow_event":
return <FlowEventLine block={block} />;
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
