import { useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 阅读器 tab 栏：样式复制自 .session-tab（.viewer-tab，不共用，
// 防样式漂移）。点 tab 激活，× 关闭（关最后 → pane 收起）。
// tab 右键（或点 ▾）出批量关闭菜单：关自己/右侧/左侧/全部。
const MENU_MAX_H = 160; // 菜单定位时给底部留的余量

interface MenuState {
  id: string;
  x: number;
  y: number;
}

export function ViewerTabBar(): React.JSX.Element | null {
  const tabs = useStore((s) => s.viewer.tabs);
  const activeId = useStore((s) => s.viewer.activeId);
  const activateViewerTab = useStore((s) => s.activateViewerTab);
  const closeViewerTab = useStore((s) => s.closeViewerTab);
  const closeViewerAll = useStore((s) => s.closeViewerAll);
  const closeViewerLeft = useStore((s) => s.closeViewerLeft);
  const closeViewerRight = useStore((s) => s.closeViewerRight);
  const closeViewerOthers = useStore((s) => s.closeViewerOthers);
  const t = useT();
  const [menu, setMenu] = useState<MenuState | null>(null);

  if (tabs.length === 0) return null;

  const openMenu = (id: string, x: number, y: number): void =>
    setMenu({ id, x, y });

  const runMenu = (fn: (id: string) => void): void => {
    if (menu) fn(menu.id);
    setMenu(null);
  };

  const menuItems = (id: string): { label: string; disabled: boolean; run: () => void }[] => {
    const idx = tabs.findIndex((x) => x.id === id);
    return [
      { label: t("vw.closeThis"), disabled: false, run: () => closeViewerTab(id) },
      { label: t("vw.closeRight"), disabled: idx < 0 || idx === tabs.length - 1, run: () => closeViewerRight(id) },
      { label: t("vw.closeLeft"), disabled: idx <= 0, run: () => closeViewerLeft(id) },
      { label: t("vw.closeOthers"), disabled: idx < 0 || tabs.length <= 1, run: () => closeViewerOthers(id) },
      { label: t("vw.closeAllTabs"), disabled: false, run: () => closeViewerAll() },
    ];
  };

  return (
    <div className="viewer-tabs" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={`viewer-tab ${tab.id === activeId ? "active" : ""}`}
          title={tab.path}
          onClick={() => activateViewerTab(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(tab.id, e.clientX, e.clientY);
          }}
        >
          <span className="tab-title">{tab.name}</span>
          <button
            className="tab-x"
            title={t("vw.tabCloseTip")}
            onClick={(e) => {
              e.stopPropagation();
              closeViewerTab(tab.id);
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
              openMenu(tab.id, r.left, r.bottom);
            }}
          >
            ▾
          </button>
        </div>
      ))}
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
