import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";

// Rightmost pane of the split view (sidebar · chat · browser). In
// embedded mode the actual page lives in a WebContentsView owned by the
// main process (it is drawn *above* the renderer),
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
      // 遮罩/拖拽隐藏时仍上报真实几何 + covered 标记：main
      // 只记不摆（view 照旧藏），诊断摘要不会把「弹窗开着」
      // 误读成「页面失踪（0 尺寸）」。
      const covered = document.querySelector(".overlay") !== null;
      const visible = !covered && !suspended && r.width >= 40 && r.height >= 40;
      void window.blm.browser.setBounds(
        visible
          ? { x: r.left, y: r.top, width: r.width, height: r.height }
          : { x: r.left, y: r.top, width: r.width, height: r.height, covered: true },
      );
      // 高分屏 DPI 排障：把渲染层视口一并带给主进程——
      // 主进程对照窗口内容区尺寸，不一致即「窗口 DPI 上下文
      // 与屏幕缩放分叉」（非整数缩放/改缩放未重启的高发坑，
      // 表现为 pane 满/放大时右、下成片空白），主进程据此
      // 重同步窗口。诊断摘要也用它核对渲染层坐标系。
      void window.blm.browser.setViewport?.({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      }).catch(() => undefined);
    };    const sync = (): void => {
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
    // 自愈兜底：view 由主进程按我们上报的 rect 摆位，若首推与
    // 首帧布局之间有竞态（view 已按旧 rect 画出），仅靠首次
    // sync 收不回来。延后一拍再推一次，把页面钉准。
    const settle = setTimeout(sync, 120);
    // 周期对账兜底：max/full 切换、窗口缩放、高分屏取整
    // 等路径下若任一事件与原生 view 重摆交错，view 会停在
    // 旧 rect（pane 长大了、页面没跟上 = 右/下空白）。
    // 事件驱动收不齐就按时间兜——每秒推一次真实 rect，
    // 主进程 same 短路，无变化零开销。
    const beat = setInterval(sync, 1000);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      clearInterval(beat);
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
