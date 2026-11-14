import { useStore } from "../../store";
import { useT } from "../../i18n";

// 阅读器 tab 栏：样式复制自 .session-tab（.viewer-tab，不共用，
// 防样式漂移）。点 tab 激活，× 关闭（关最后 → pane 收起）。

export function ViewerTabBar(): React.JSX.Element | null {
  const tabs = useStore((s) => s.viewer.tabs);
  const activeId = useStore((s) => s.viewer.activeId);
  const activateViewerTab = useStore((s) => s.activateViewerTab);
  const closeViewerTab = useStore((s) => s.closeViewerTab);
  const t = useT();

  if (tabs.length === 0) return null;

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
        </div>
      ))}
    </div>
  );
}
