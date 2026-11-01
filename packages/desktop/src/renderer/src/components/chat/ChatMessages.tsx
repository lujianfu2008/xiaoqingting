import { useMemo } from "react";
import type { Block } from "@blm/protocol";
import { useT } from "../../i18n";
import { MessageBlock, StreamingMessage } from "./MessageBlock";

interface ChatMessagesProps {
  blocks: Block[];
  streamingText: string;
  error: string | null;
  voiceMsg: string | null;
  /** No session selected: nudge toward picking/creating one instead of chatting. */
  noSession?: boolean;
  bottomRef: React.RefObject<HTMLDivElement>;
}

export function ChatMessages({
  blocks,
  streamingText,
  error,
  voiceMsg,
  noSession,
  bottomRef,
}: ChatMessagesProps): React.JSX.Element {
  const t = useT();
  // 任务清单已结构化渲染：TodoWrite 的配对 tool_result（迟到一个消息）按
  // id 前联隐藏，时间线只剩 📋 清单。旧历史没有 task_list 块，原样渲染。
  const hiddenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of blocks) if (b.kind === "task_list") ids.add(b.id);
    return ids;
  }, [blocks]);
  const visible =
    hiddenIds.size === 0
      ? blocks
      : blocks.filter(
          (b) =>
            !((b.kind === "tool_call" || b.kind === "tool_result") && hiddenIds.has(b.id)),
        );
  return (
    <div className="chat">
      {blocks.length === 0 && !streamingText && (
        <div style={{ color: "var(--muted)", margin: "auto", textAlign: "center" }}>
          {noSession ? t("chat.noSession") : t("chat.empty")}
        </div>
      )}
      {visible.map((b, i) => (
        <MessageBlock key={i} block={b} />
      ))}
      {streamingText && <StreamingMessage text={streamingText} />}
      {error && <div className="tool-block error">{error}</div>}
      {voiceMsg && (
        <div className="tool-block" style={{ color: "var(--muted)" }}>
          🎤 {voiceMsg}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
