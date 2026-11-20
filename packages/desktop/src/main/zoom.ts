import type { WebContents } from "electron";
import { safeSend } from "./safeSend";

// 两套内容缩放（内置浏览器页面 / 内置阅读器）共用这一个
// 键表与常量——同键、同步进，只差落点：页面落 zoomFactor
// （main 直接改），阅读器转发给 renderer 应用 CSS zoom
// （renderer/src/components/viewer/zoom.ts）。改快捷键
// 只动这里。
//
// 键：Ctrl/⌘ + =|-|0；滚轮：页面走 Chromium 原生
// Ctrl+滚轮（zoom-changed 是改完的通知，只夹边界）；
// 阅读器在 renderer 里 document 捕获（React onWheel 是
// passive 的，拦不住）。快捷键钩子 preventDefault 会
// 一并压掉应用菜单同名 accelerator（Electron 文档语义），
// 所以菜单项的 accelerator 只做展示，永远轮不到触发。

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.1;

export type ZoomCmd = "in" | "out" | "reset";

export function clampZoom(f: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f));
}

/** Ctrl/⌘ + =|-|0 → 缩放命令（其余键 null）。 */
function parseZoomCmd(input: {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
}): ZoomCmd | null {
  if (input.type !== "keyDown" || !(input.control || input.meta)) return null;
  const k = input.key;
  if (k === "=" || k === "+") return "in";
  if (k === "-" || k === "_") return "out";
  if (k === "0") return "reset";
  return null;
}

/** 命中缩放键：preventDefault（压掉页面与菜单两层）后调 apply。 */
function wireZoomKeys(wc: WebContents, apply: (cmd: ZoomCmd) => void): void {
  wc.on("before-input-event", (event, input) => {
    const cmd = parseZoomCmd(input);
    if (!cmd) return;
    event.preventDefault();
    apply(cmd);
  });
}

/** 内置浏览器页面（pane 内 view 与弹窗）：缩放页面本体。 */
export function wirePageZoom(wc: WebContents): void {
  // Ctrl+滚轮：Chromium 原生行为已经自己改了 zoomFactor
  // （zoom-changed 是改完的通知，不是请求——再乘一遍会
  // 双重缩放），这里只把越界的值夹回范围。
  wc.on("zoom-changed", () => {
    const cur = wc.getZoomFactor();
    if (cur < ZOOM_MIN) wc.setZoomFactor(ZOOM_MIN);
    else if (cur > ZOOM_MAX) wc.setZoomFactor(ZOOM_MAX);
  });
  wireZoomKeys(wc, (cmd) => {
    const cur = wc.getZoomFactor();
    wc.setZoomFactor(cmd === "reset" ? 1 : clampZoom(cmd === "in" ? cur * ZOOM_STEP : cur / ZOOM_STEP));
  });
}

/** 承载阅读器的窗口（主壳 + 阅读器弹窗）：转发给 renderer。 */
export function wireViewerZoom(wc: WebContents): void {
  wireZoomKeys(wc, (cmd) => {
    safeSend(wc, "blm:viewer:zoom", cmd);
  });
}
