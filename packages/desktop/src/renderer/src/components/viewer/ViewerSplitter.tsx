import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { Splitter } from "../Splitter";
import { useStore } from "../../store";
import { LS } from "../../store/persist";

// 阅读器内部：文件树右缘的竖拖条。树宽拖动改的是
// .vtree 的 width（CSS 变量），localStorage 记住；
// 树收起（▸ 竖条）或无根目录时不渲染。

const VTREE_DEFAULT = 200;
const VTREE_MIN = 140;
const VTREE_MAX = 480;

export function ViewerSplitter(): React.JSX.Element | null {
  const t = useT();
  // 与 FileTree 同源：无根（tab 全关）或树折叠就不渲染拖条。
  const treeRoot = useStore((s) => s.viewer.treeRoot);
  const collapsed = useStore((s) => s.viewer.treeCollapsed);
  const [w, setW] = useState(loadVtreeW);

  // 树宽走 CSS 变量 + localStorage 持久（store 外的纯布局偏好，
  // 与 sidebarWidth 同一模式）。
  useEffect(() => {
    document.documentElement.style.setProperty("--vtree-w", `${w}px`);
    localStorage.setItem(LS.vtreeWidth, String(w));
  }, [w]);

  if (!treeRoot || collapsed) return null;
  return (
    <Splitter
      label={t("pane.dragW")}
      // Splitter 给的是窗口坐标 clientX；树宽是「指针到树左缘」
      // 的距离——阅读器在窗口右侧时树左缘离窗口原点几百 px，
      // 直接拿 clientX 当宽度会顶死上限（pane 放大挪到左侧后才
      // 碰巧能用，数值也带着偏移）。换算成相对 .viewer-body
      // 左缘的局部坐标，树在窗口哪里、pane 放大与否都跟手。
      onDrag={(x, el) => {
        const body = el.closest(".viewer-body");
        const left = body ? body.getBoundingClientRect().left : 0;
        setW(Math.min(VTREE_MAX, Math.max(VTREE_MIN, Math.round(x - left))));
      }}
      onReset={() => setW(VTREE_DEFAULT)}
    />
  );
}

function loadVtreeW(): number {
  const n = Number(localStorage.getItem(LS.vtreeWidth));
  return Number.isFinite(n) && n >= VTREE_MIN ? n : VTREE_DEFAULT;
}
