import { useCallback, useEffect, useState } from "react";
import { LS } from "../../store/persist";

// 阅读器内容缩放：Ctrl/⌘+滚轮 与 Ctrl+=/-/0 快捷键统一进
// 一条命令流。滚轮在 document 捕获（内容多为 img/pre，不拦
// 就轮不到我们；React onWheel 是 passive 的，拦不住）；
// 快捷键由 main 的 before-input-event / 菜单经 IPC 转发
// （blm:viewer:zoom，见 preload 的 onViewerZoom）。
//
// 命令流是模块级广播：主窗同一时刻只有一个 viewer 组件挂载
// （活动 tab），弹窗是独立文档各自一套，广播即点对点。
//
// 档位按文件 kind 分开记（图片看不清 ≠ 源码字太小），
// localStorage 持久。用 CSS zoom 而非 transform：zoom 参与
// 布局，文本/树放大后按新尺寸排版、滚动与选择照常；transform
// 只做视觉缩放，滚动范围是错的。倍率 0.5–3，步进 ×1.1
// （滚轮一格 ≈10%，快捷键同档），0 复位。

export const VIEWER_ZOOM_MIN = 0.5;
export const VIEWER_ZOOM_MAX = 3;
// 步进与范围与 main/zoom.ts 的键表共用一份约定
// （跨 bundle 不共 import，改一处必改另一处）。
const STEP = 1.1;

const clamp = (v: number): number =>
  Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, v));

function loadZoom(kind: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(LS.viewerZoom) ?? "{}") as Record<
      string,
      number
    >;
    const v = all[kind];
    return typeof v === "number" && Number.isFinite(v)
      ? clamp(v)
      : 1;
  } catch {
    return 1;
  }
}

function saveZoom(kind: string, zoom: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(LS.viewerZoom) ?? "{}") as Record<
      string,
      number
    >;
    if (zoom === 1) delete all[kind];
    else all[kind] = zoom;
    localStorage.setItem(LS.viewerZoom, JSON.stringify(all));
  } catch {
    // 坏数据当缺省，不阻塞阅读
  }
}

/** 缩放命令只带方向（菜单快捷键没有更细的量）。 */
export type ZoomCmd = "in" | "out" | "reset";

type Bus = { subs: Set<(cmd: ZoomCmd) => void>; wire: boolean };

const bus: Bus = { subs: new Set(), wire: false };

function dispatch(cmd: ZoomCmd): void {
  for (const fn of bus.subs) fn(cmd);
}

function wireOnce(): void {
  if (bus.wire) return;
  bus.wire = true;
  // IPC：菜单/快捷键（main → preload → 这里）。旧 preload
  // 无此通道（onViewerZoom 缺失）时只剩滚轮手势。
  window.blm.onViewerZoom?.(dispatch);
  // Ctrl/⌘+滚轮（含触控板捏合——Chromium 捏合也走 ctrl+wheel）：
  // 只认阅读器内容区内的指针，聊天区 Shift+滚轮（调字号）不冲突。
  document.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as Element | null;
      // 阅读器 pane 全域（主窗 .viewer-pane / 弹窗整页）：
      // 指针不必先点进内容，悬停即缩——与浏览器的手感一致。
      if (!t?.closest?.(".viewer-pane, .viewer-popup-root")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY !== 0) dispatch(e.deltaY < 0 ? "in" : "out");
    },
    { passive: false, capture: true },
  );
}

/**
 * 阅读器内容缩放。`kind` = registry 的 ViewerKind（按格式分档）。
 * 返回 [倍率, 挂到内容根元素的 style]。
 */
export function useViewerZoom(kind: string): [number, React.CSSProperties] {
  const [zoom, setZoom] = useState(() => loadZoom(kind));

  useEffect(() => {
    // 切 tab（kind 变化）载回该格式的档位。
    setZoom(loadZoom(kind));
  }, [kind]);

  const apply = useCallback((cmd: ZoomCmd): void => {
    setZoom((z) => {
      const next = cmd === "reset" ? 1 : clamp(cmd === "in" ? z * STEP : z / STEP);
      // 走到头就钉在边界（多次 +0 无副作用），UI 不闪。
      return Math.abs(next - z) < 0.001 ? z : next;
    });
  }, []);

  useEffect(() => {
    saveZoom(kind, zoom);
  }, [kind, zoom]);

  useEffect(() => {
    wireOnce();
    bus.subs.add(apply);
    return () => {
      bus.subs.delete(apply);
    };
  }, [apply]);

  return [zoom, { zoom: `${zoom}` }];
}
