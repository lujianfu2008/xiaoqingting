import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";
import { FileTree } from "./viewer/FileTree";
import { ViewerTabBar } from "./viewer/TabBar";
import { ViewerSplitter } from "./viewer/ViewerSplitter";
import { kindOf, loadViewer, type ViewerKind } from "./viewer/registry";

// 内置文件阅读器 pane：bar（文件名 + 模式按钮）+ body =
// 文件树（可折叠）| tab 栏 + 内容。viewer 组件按 kind 动态
// import（未用到的格式解析器不进主壳）。

/** 当前 tab 内容：按需加载的 viewer 组件。 */
function ViewerBody({ path, name, kind }: { path: string; name: string; kind: ViewerKind }): React.JSX.Element | null {
  const t = useT();
  const [Comp, setComp] = useState<Awaited<ReturnType<typeof loadViewer>>>(null);

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
  return <Comp path={path} name={name} />;
}

export function ViewerPane(props: { chrome?: PaneChrome }): React.JSX.Element | null {
  const viewer = useStore((s) => s.viewer);
  const closeViewerTab = useStore((s) => s.closeViewerTab);
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
        {/* 关闭整个阅读器（参照浏览器 pane 的 ✕）：当前 tab 有
            内容则关它（pane 随之收起），空 pane 也直接收。 */}
        <button
          className="viewer-btn"
          title={t("vw.closePane")}
          onClick={() => {
            if (active) closeViewerTab(active.id);
            else useStore.getState().setViewerOpen(false);
          }}
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
