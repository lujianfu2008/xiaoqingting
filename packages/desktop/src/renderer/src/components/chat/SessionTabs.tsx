import { useStore } from "../../store";
import { useT } from "../../i18n";

// 会话 tab 栏（聊天面板顶部）：点过的会话在这里并开，各 tab 的
// 草稿/附件互不影响。busy 的 tab 显示小红点（后台回复进行中也看得见）。
export function SessionTabs(): React.JSX.Element | null {
  const openTabs = useStore((s) => s.openTabs);
  const sessions = useStore((s) => s.sessions);
  const sharedSessions = useStore((s) => s.sharedSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const busy = useStore((s) => s.busy);
  const selectSession = useStore((s) => s.selectSession);
  const selectSharedSession = useStore((s) => s.selectSharedSession);
  const closeTab = useStore((s) => s.closeTab);
  const t = useT();

  if (openTabs.length === 0) return null;

  // tab 标题：自有会话用 title，共享/任务线程补 owner 前缀。
  const titleOf = (id: string): { label: string; shared: boolean } => {
    const own = sessions.find((x) => x.session_id === id);
    if (own) return { label: own.title || t("br.fallbackTitle"), shared: false };
    const sh = sharedSessions.find((x) => x.session_id === id);
    if (sh) return { label: `${sh.owner} / ${sh.title}`, shared: true };
    return { label: t("br.fallbackTitle"), shared: false };
  };

  return (
    <div className="session-tabs" role="tablist">
      {openTabs.map((id) => {
        const { label, shared } = titleOf(id);
        const active = id === currentSessionId && (sharedView === shared);
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            className={`session-tab ${active ? "active" : ""}`}
            title={label}
            onClick={() => void (shared ? selectSharedSession(id) : selectSession(id))}
          >
            {busy[id] && <span className="tab-busy-dot" title={t("chat.tabBusyTip")} />}
            <span className="tab-title">{label}</span>
            <button
              className="tab-x"
              title={t("chat.tabCloseTip")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
