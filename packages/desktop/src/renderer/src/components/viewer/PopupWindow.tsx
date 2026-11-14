import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { kindOf, loadViewer, type ViewerKind } from "./registry";

// 阅读器弹窗窗口（主窗「弹窗」按钮打开）：独立 BrowserWindow，
// 加载同一 renderer 页 + #viewer-popup hash。直接按路径
// 加载对应 viewer 组件——不依赖主窗的 viewer store（两个窗口
// 的 store 各自独立，tab 状态不互通，弹窗只负责看这一个文件）。

/** 当前路径对应的按需加载 viewer。 */
function PopupBody({ path, name, kind }: { path: string; name: string; kind: ViewerKind }): React.JSX.Element | null {
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

  if (Comp === null) return <div className="viewer-status">{t("vw.unsupported")}</div>;
  return <Comp path={path} name={name} />;
}

/** 弹窗窗口的整页 UI：标题栏（文件名+路径）+ 内容。 */
export function ViewerPopupWindow({ path }: { path: string }): React.JSX.Element {
  const t = useT();
  const name = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? path;
  return (
    <div className="viewer-popup-root">
      <div className="viewer-bar">
        <span className="viewer-title" title={path}>
          {name}
        </span>
        <span className="viewer-path" title={path}>
          {path}
        </span>
        {/* 与主窗 bar 一致：随时可换系统程序看这个文件。 */}
        <button
          className="viewer-btn"
          title={t("vw.sysOpenTip")}
          onClick={() => void window.blm.viewer.openExternal(path)}
        >
          {t("vw.openExternal")}
        </button>
      </div>
      <div className="viewer-content">
        <PopupBody path={path} name={name} kind={kindOf(name)} />
      </div>
    </div>
  );
}
