import type { Block } from "@blm/protocol";

function ToolResult({ block }: { block: Extract<Block, { kind: "tool_result" }> }): React.JSX.Element {
  return (
    <div className={`tool-block ${block.is_error ? "error" : ""}`}>
      {block.is_error ? "⚠ " : "✓ "}
      {block.content.slice(0, 300)}
      {block.content.length > 300 ? "…" : ""}
    </div>
  );
}

export function MessageBlock({ block }: { block: Block }): React.JSX.Element {
switch (block.kind) {
case "user_text":
return <UserText text={block.text} />;
case "text":
return <div className="msg agent">{block.text}</div>;
case "tool_call":
return <div className="tool-block">🔧 {block.tool_name}</div>;
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
