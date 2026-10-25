import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";

// Left pane of the split view. In embedded mode the actual page lives in a
// WebContentsView owned by the main process (it is drawn *above* the renderer),
// so this component only provides the hole: it reports the stage's rect over
// IPC and collapses it to zero while a modal overlay covers the window.
//
// A popup is opt-in per page: the 弹窗 button moves only the page on screen to
// its own window, and while it is out this component leaves a small bar with
// the way back, so the popup is never a one-way trip. Agent opens always land
// back here in the main window.
export function BrowserPane(props: {
  suspended?: boolean;
  chrome?: PaneChrome;
}): React.JSX.Element | null {
  const browser = useStore((s) => s.browser);
  const setBrowserMode = useStore((s) => s.setBrowserMode);
  const closeBrowser = useStore((s) => s.closeBrowser);
  const stageRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const embedded = browser.mode === "embedded" && browser.open;
  const inPopup = browser.mode === "popup" && browser.open;
  // A splitter drag needs the pointer over this pane, but the native view paints
  // above the renderer and would swallow it — hide the page for the duration.
  const suspended = props.suspended === true;

  useEffect(() => {
    if (!embedded) return;
    const stage = stageRef.current;
    if (!stage) return;

    let frame = 0;
    const push = (): void => {
      const r = stage.getBoundingClientRect();
      // Any overlay (settings / share / permission dialogs) must cover the
      // window, but a native view always paints on top — hide it instead.
      const covered = document.querySelector(".overlay") !== null;
      const visible = !covered && !suspended && r.width >= 40 && r.height >= 40;
      void window.blm.browser.setBounds(
        visible
          ? { x: r.left, y: r.top, width: r.width, height: r.height }
          : { x: 0, y: 0, width: 0, height: 0 },
      );
    };
    const sync = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(push);
    };

    const ro = new ResizeObserver(sync);
    ro.observe(stage);
    // Overlays are mounted/unmounted anywhere under #root.
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", sync);
    sync();

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", sync);
      void window.blm.browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [embedded, suspended]);

  if (inPopup) {
    return (
      <div className="browser-popup-tip">
        {t("br.popupTip")}
        <button
          className="browser-btn"
          title={t("br.embedBackTip")}
          onClick={() => void setBrowserMode("embedded")}
        >
          {t("br.embedBack")}
        </button>
        <button className="browser-btn" title={t("br.close")} onClick={() => void closeBrowser()}>
          ✕
        </button>
      </div>
    );
  }

  if (!embedded) return null;

  return (
    <section className="browser-pane">
      <div className="browser-bar">
        <span className="browser-title" title={browser.url || undefined}>
          {browser.title || t("br.fallbackTitle")}
        </span>
        <span className="browser-url" title={browser.url}>
          {browser.url}
        </span>
        <button
          className="browser-btn"
          title={t("br.popoutTip")}
          onClick={() => void setBrowserMode("popup")}
        >
          {t("br.popout")}
        </button>
        <button className="browser-btn" title={t("br.close")} onClick={() => void closeBrowser()}>
          ✕
        </button>
        {props.chrome && <PaneTools {...props.chrome} />}
      </div>
      <div className={suspended ? "browser-stage suspended" : "browser-stage"} ref={stageRef} />
    </section>
  );
}
