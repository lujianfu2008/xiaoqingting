import { useT } from "../../i18n";

// Window chrome for a single pane. Two ways to expand it:
//   放大 — the pane takes the whole area right of the sidebar (the session list
//          stays visible, the other right-hand pane steps aside);
//   满屏 — the pane takes the whole window.
// Minimising folds the pane into a 34px rail that expands on click. Rendered
// inline in panes that already have a toolbar (the browser bar) and floating in
// the corner of the ones that do not (sidebar, chat).
export type PaneId = "sidebar" | "browser" | "chat";

/** How the pane is currently expanded. Folded panes render no tools at all. */
export type PaneState = "normal" | "max" | "full";

export interface PaneChrome {
  state: PaneState;
  /** Absent for the sidebar: filling the area right of the sidebar is all it has. */
  onMaximize?: () => void;
  /** Absent for the sidebar: filling the whole window is its only expansion. */
  onFullscreen?: () => void;
  /** Tooltip for 满屏; the sidebar hides the other panes rather than itself. */
  fullscreenTitle?: string;
  onMinimize(): void;
  onRestore(): void;
}

// Glyphs alone (⤢ / ⛶) are too easy to misread, so the buttons carry a short
// label; the longer explanation lives in the tooltip. In a narrow browser bar
// the label folds away (see .tool-label in layout.css) to keep it on one line.
export function PaneTools(props: PaneChrome & { floating?: boolean }): React.JSX.Element {
  const t = useT();
  const canMaximize = props.onMaximize !== undefined && props.state !== "max";
  const canFullscreen = props.onFullscreen !== undefined && props.state !== "full";
  return (
    <div className={props.floating ? "pane-tools floating" : "pane-tools"}>
      {canMaximize && (
        <button
          className="pane-tool"
          title={t("pane.maxTip")}
          onClick={props.onMaximize}
        >
          <span className="tool-icon">⤢</span>
          <span className="tool-label">{t("pane.max")}</span>
        </button>
      )}
      {canFullscreen && (
        <button
          className="pane-tool"
          title={props.fullscreenTitle ?? t("pane.fullTip")}
          onClick={props.onFullscreen}
        >
          <span className="tool-icon">⛶</span>
          <span className="tool-label">{t("pane.full")}</span>
        </button>
      )}
      {props.state === "normal" ? (
        <button className="pane-tool" title={t("pane.minTip")} onClick={props.onMinimize}>
          <span className="tool-icon">⇤</span>
          <span className="tool-label">{t("pane.min")}</span>
        </button>
      ) : (
        <button className="pane-tool" title={t("pane.restoreTip")} onClick={props.onRestore}>
          <span className="tool-icon">⤡</span>
          <span className="tool-label">{t("pane.restore")}</span>
        </button>
      )}
    </div>
  );
}

// Collapsed pane: a narrow strip that brings the pane back when clicked.
export function PaneRail(props: {
  side: "left" | "right";
  label: string;
  icon: string;
  onExpand(): void;
}): React.JSX.Element {
  const t = useT();
  return (
    <button
      className={props.side === "right" ? "pane-rail right" : "pane-rail"}
      title={t("pane.expandTip", { label: props.label })}
      onClick={props.onExpand}
    >
      <span className="rail-icon">{props.side === "right" ? "◀" : "▶"}</span>
      <span className="rail-label">{props.label}</span>
      <span className="rail-icon">{props.icon}</span>
    </button>
  );
}
