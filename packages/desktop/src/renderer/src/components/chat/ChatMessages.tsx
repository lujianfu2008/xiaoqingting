import { useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "@blm/protocol";
import { useT } from "../../i18n";
import { MessageBlock, StreamingMessage } from "./MessageBlock";

// ---------- 历史折叠（纯 UI，不改协议/存储） ----------
// 块很多时默认只显示最近一页，顶部一条 history 分隔线；
// 点一次向上多展开一层（层层翻），全部展开后线消失、可再收起。
// 折叠边界对齐「回合」：历史切点回退到最近一条 user_text，
// 一次回复（文本+工具调用/结果）不会被拦腰截断。

const PAGE_BLOCKS = 40; // 每层展开/收起的块数
const TRIGGER_BLOCKS = 60; // 超过才启用折叠（页大小的一倍半，避免刚超就折）

/**
 * 计算折叠切点：默认显示最近 keep 块；切点回退到最近一条
 * user_text（含它——回合起点必须和它的回复待在一起）。
 * 全部块都归入一页（找不到 user_text 边界）时不折叠。
 */
function foldIndex(blocks: Block[], keep: number): number {
  if (blocks.length <= keep) return 0;
  const cut = blocks.length - keep;
  // 在 [0, cut) 里找最后一个 user_text；找不到则不折（0 = 全显）。
  for (let i = cut; i >= 0; i--) {
    if (blocks[i]?.kind === "user_text") return i;
  }
  return 0;
}

interface ChatMessagesProps {
  blocks: Block[];
  streamingText: string;
  error: string | null;
  /** 任务/协作流轻提示：数秒自动消失的信息条（与常驻 error 区分）。 */
  notice: string | null;
  voiceMsg: string | null;
  /** No session selected: nudge toward picking/creating one instead of chatting. */
  noSession?: boolean;
  /** 当前会话 id：切换会话时历史折叠层数归零（回到最近一页）。 */
  sessionId?: string | null;
  bottomRef: React.RefObject<HTMLDivElement>;
  /** 回合进行中（busy）：重新生成禁用。 */
  busy?: boolean;
  /** 重新生成回调（最后一条助手回复的按钮触发）。 */
  onRegenerate?: () => void;
}

export function ChatMessages({
  blocks,
  streamingText,
  error,
  notice,
  voiceMsg,
  noSession,
  sessionId,
  bottomRef,
  busy,
  onRegenerate,
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

  // ---------- 历史折叠状态 ----------
  // 展开层数在会话切换时归零（回到最近一页）——各会话的翻页
  // 进度互不保留，与「切会话跳底部」一致。
  const [expandSession, setExpandSession] = useState<string | null | undefined>(sessionId);
  const [pages, setPages] = useState(0);
  useEffect(() => {
    if (sessionId !== expandSession) {
      setExpandSession(sessionId);
      setPages(0);
    }
  }, [sessionId, expandSession]);
  const foldable = visible.length > TRIGGER_BLOCKS;
  const naturalCut = foldable ? foldIndex(visible, PAGE_BLOCKS) : 0;
  // 每页从自然切点再向上让出 PAGE_BLOCKS 块（同样回合对齐）。
  const cut =
    pages > 0
      ? foldIndex(visible, Math.max(PAGE_BLOCKS * (pages + 1), PAGE_BLOCKS))
      : naturalCut;
  const hiddenCount = cut; // 被藏起来的头部块数
  const head = cut > 0 ? visible.slice(0, cut) : [];
  const tail = cut > 0 ? visible.slice(cut) : visible;
  // 点展开后视口要跟着内容走：把锚点放在「展开后可见区的第一块」
  // （tail 的第一个元素），滚动到它而不是底部——否则新增内容全在
  // 视口上方，看起来像「点了没反应」。ref 挂在尾部片段首块上。
  const tailStartRef = useRef<HTMLDivElement | null>(null);

  // 最后一个 text 块 = 最近一次助手回复（回复完成时才以 message_block
  // 落地）——重新生成按钮只挂它身上。
  const lastAgentText = useMemo(() => {
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i].kind === "text") return i;
    }
    return -1;
  }, [tail]);

  return (
    <div className="chat">
      {blocks.length === 0 && !streamingText && (
        <div style={{ color: "var(--muted)", margin: "auto", textAlign: "center" }}>
          {noSession ? t("chat.noSession") : t("chat.empty")}
        </div>
      )}
      {hiddenCount > 0 && (
        <button
          className="history-divider"
          title={t("chat.historyTip", { n: hiddenCount })}
          onClick={() => {
            setPages((p) => p + 1);
            // 下一帧内容已变：把展开出来的第一块滚进视口
            // （视口停在原处会像「点了没反应」）。
            requestAnimationFrame(() =>
              tailStartRef.current?.scrollIntoView({ behavior: "auto", block: "start" }),
            );
          }}
        >
          <span className="history-line" />
          <span className="history-label">
            {t("chat.historyMore", { n: hiddenCount })}
          </span>
          <span className="history-line" />
        </button>
      )}
      {pages > 0 && (
        <button
          className="history-divider collapse"
          title={t("chat.historyCollapseTip")}
          onClick={() => {
            setPages(0);
            // 收起后回到最近一页：视口跟到底部（收起点在顶部，
            // 不跟就会停在已被收起的内容上）。
            requestAnimationFrame(() =>
              bottomRef.current?.scrollIntoView({ behavior: "auto" }),
            );
          }}
        >
          <span className="history-line" />
          <span className="history-label">{t("chat.historyCollapse")}</span>
          <span className="history-line" />
        </button>
      )}
      {head.map((b, i) => (
        <MessageBlock key={`h${i}`} block={b} />
      ))}
      {/* 尾部片段首块的锚点：点 history 展开时视口滚到这里。 */}
      <div ref={tailStartRef} style={{ height: 0 }} />
      {tail.map((b, i) => (
        <MessageBlock
          key={i}
          block={b}
          showRegenerate={Boolean(onRegenerate) && i === lastAgentText}
          regenDisabled={busy === true}
          onRegenerate={onRegenerate}
        />
      ))}
      {streamingText && <StreamingMessage text={streamingText} />}
      {error && <div className="tool-block error">{error}</div>}
      {notice && <div className="tool-block notice">🔔 {notice}</div>}
      {voiceMsg && (
        <div className="tool-block" style={{ color: "var(--muted)" }}>
          🎤 {voiceMsg}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
