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
  return (
    <div className="chat">
      {blocks.length === 0 && !streamingText && (
        <div style={{ color: "var(--muted)", margin: "auto", textAlign: "center" }}>
          {noSession ? t("chat.noSession") : t("chat.empty")}
        </div>
      )}
      {blocks.map((b, i) => (
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
