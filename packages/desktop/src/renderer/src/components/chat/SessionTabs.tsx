import { useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 会话 tab 栏（聊天面板顶部）：点过的会话在这里并开，各 tab 的
// 草稿/附件互不影响。busy 的 tab 显示小红点（后台回复进行中也看得见）。
// tab 右键（或点 ▾）出批量关闭菜单：关自己/右侧/左侧/全部
// （与阅读器 tab 同款交互与样式）。
const MENU_MAX_H = 160; // 菜单定位时给底部留的余量

interface MenuState {
  id: string;
  x: number;
  y: number;
}

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
  const [menu, setMenu] = useState<MenuState | null>(null);

  if (openTabs.length === 0) return null;

  // tab 标题：自有会话用 title，共享/任务线程补 owner 前缀。
  const titleOf = (id: string): { label: string; shared: boolean } => {
    const own = sessions.find((x) => x.session_id === id);
    if (own) return { label: own.title || t("br.fallbackTitle"), shared: false };
    const sh = sharedSessions.find((x) => x.session_id === id);
    if (sh) return { label: `${sh.owner} / ${sh.title}`, shared: true };
    return { label: t("br.fallbackTitle"), shared: false };
  };

  const openMenu = (id: string, x: number, y: number): void =>
    setMenu({ id, x, y });

  const menuItems = (id: string): { label: string; disabled: boolean; run: () => void }[] => {
    const idx = openTabs.indexOf(id);
    return [
      { label: t("vw.closeThis"), disabled: false, run: () => closeTab(id) },
      { label: t("vw.closeRight"), disabled: idx < 0 || idx === openTabs.length - 1, run: () => { openTabs.slice(idx + 1).forEach((x) => closeTab(x)); } },
      { label: t("vw.closeLeft"), disabled: idx <= 0, run: () => { openTabs.slice(0, idx).forEach((x) => closeTab(x)); } },
      { label: t("vw.closeAllTabs"), disabled: false, run: () => { [...openTabs].forEach((x) => closeTab(x)); } },
    ];
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
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(id, e.clientX, e.clientY);
            }}
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
            <button
              className="tab-x tab-menu-btn"
              title={t("vw.tabMenuTip")}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenu(id, r.left, r.bottom);
              }}
            >
              ▾
            </button>
          </div>
        );
      })}
      {menu && (() => {
        const items = menuItems(menu.id);
        return (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 1000 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          >
            <div
              className="tab-close-menu"
              style={{
                position: "fixed",
                left: Math.min(menu.x, window.innerWidth - 150),
                top: Math.min(menu.y, window.innerHeight - MENU_MAX_H),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  className="tab-close-menu-item"
                  disabled={it.disabled}
                  onClick={it.run}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
