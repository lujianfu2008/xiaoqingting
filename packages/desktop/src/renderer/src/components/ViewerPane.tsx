import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";
import { FileTree } from "./viewer/FileTree";
import { ViewerTabBar } from "./viewer/TabBar";
import { ViewerSplitter } from "./viewer/ViewerSplitter";
import { kindOf, loadViewer, type ViewerKind } from "./viewer/registry";
import { useViewerZoom } from "./viewer/zoom";

// 内置文件阅读器 pane：bar（文件名 + 模式按钮）+ body =
// 文件树（可折叠）| tab 栏 + 内容。viewer 组件按 kind 动态
// import（未用到的格式解析器不进主壳）。内容缩放
// （Ctrl+滚轮 / Ctrl+=·-·0，见 viewer/zoom.ts）：文本类加在
// 包裹层（CSS zoom 参与排版），图片/PDF 收 zoom 值自己缩
// （图片 scale 本体、PDF 按新倍率重渲，见各 viewer）；
// 音视频缩放无意义，不缩。树与 tab 栏不跟着动。

const ZOOMS_LAYOUT = new Set<string>(["text", "code", "markdown", "json"]);

/** 当前 tab 内容：按需加载的 viewer 组件。 */
function ViewerBody({ path, name, kind }: { path: string; name: string; kind: ViewerKind }): React.JSX.Element | null {
  const t = useT();
  const [Comp, setComp] = useState<Awaited<ReturnType<typeof loadViewer>>>(null);
  const [zoom, zoomStyle] = useViewerZoom(kind);

  useEffect(() => {
    let alive = true;
    setComp(null);
    void loadViewer(kind).then((c) => {
      if (alive) setComp(() => c);
    });
    return () => {
      alive = false;
    };
  }, [kind]);

  if (Comp === undefined) return null;
  if (Comp === null) return <div className="viewer-status">{t("vw.unsupported")}</div>;
  return (
    <div className="viewer-zoom" style={ZOOMS_LAYOUT.has(kind) ? zoomStyle : undefined}>
      <Comp path={path} name={name} zoom={zoom} />
    </div>
  );
}

export function ViewerPane(props: { chrome?: PaneChrome }): React.JSX.Element | null {
  const viewer = useStore((s) => s.viewer);
  const closeViewerAll = useStore((s) => s.closeViewerAll);
  const t = useT();
  const active = viewer.tabs.find((x) => x.id === viewer.activeId) ?? null;

  if (!viewer.open) return null;

  return (
    <section className="viewer-pane">
      <div className="viewer-bar">
        <span className="viewer-title" title={active?.path ?? undefined}>
          {active ? active.name : t("vw.title")}
        </span>
        <span className="viewer-path" title={active?.path}>
          {active?.path ?? ""}
        </span>
        {props.chrome && <PaneTools {...props.chrome} />}
        {/* 用系统打开：内置阅读器是默认，但用户随时可以
            换系统程序看当前文件（不做全局开关——单文件
            一次性的选择更符合「顺手看一眼」的定位）。 */}
        <button
          className="viewer-btn"
          title={t("vw.sysOpenTip")}
          disabled={!active}
          onClick={() => {
            if (active) void window.blm.viewer.openExternal(active.path);
          }}
        >
          {t("vw.openExternal")}
        </button>
        {/* 弹窗：当前文件挪到独立窗口看（参照浏览器 pane 的弹窗）。
            主窗 tab 保留——弹窗是「再看一份」，不是搬走。 */}
        <button
          className="viewer-btn"
          title={t("vw.popOutTip")}
          disabled={!active}
          onClick={() => {
            if (active) void window.blm.viewer.popOut(active.path);
          }}
        >
          {t("vw.popOut")}
        </button>
        {/* 总关闭（✕）：一键关掉全部 tab 并收起 pane——多 tab
            时逐个点 × 太啰嗦。单个 tab 仍用 tab 上的 ×。 */}
        <button
          className="viewer-btn"
          title={t("vw.closeAll")}
          onClick={closeViewerAll}
        >
          ✕
        </button>
      </div>
      <div className="viewer-body">
        <FileTree />
        {/* 树与内容之间：拖动改树宽（localStorage 记住）。 */}
        <ViewerSplitter />
        <div className="viewer-main">
          <ViewerTabBar />
          <div className="viewer-content" key={active?.id ?? "empty"}>
            {active ? (
              <ViewerBody path={active.path} name={active.name} kind={kindOf(active.name)} />
            ) : (
              <div className="viewer-status">{t("vw.title")}</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
