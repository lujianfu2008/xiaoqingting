import type { BrowserWindow } from "electron";
import {
  type BrowserMode,
  type BrowserState,
  destroyEmbedded,
  destroyPopup,
  emit,
  ensureSurface,
  liveWebContents,
  setRuntimeMode,
  state,
} from "./surfaces";

// Built-in browser used by the agent's browser_* tools. The surfaces (embedded
// view / popup window) live in ./surfaces; this module owns the commands.
//
// Rule: anything the *agent* opens is embedded in the main window (page left,
// chat right). A popup is opt-in per page — the 弹窗 button in the pane bar
// switches only the page currently on screen, and the next open embeds again.

export type { BrowserMode, BrowserState } from "./surfaces";
export {
  registerHost,
  relayout,
  setBounds,
  detach,
  state,
} from "./surfaces";

export async function open(win: BrowserWindow, url: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "网址必须以 http:// 或 https:// 开头。" };
  const wc = ensureSurface(win);
  try {
    await wc.loadURL(url);
    emit();
    return { ok: true };
  } catch (e) {
    emit();
    return { ok: false, error: `打开失败：${(e as Error).message}` };
  }
}

export async function snapshot(): Promise<{ ok: boolean; text?: string; error?: string }> {
  const wc = liveWebContents();
  if (!wc) return { ok: false, error: "浏览器未打开。" };
  try {
    const t = await wc.executeJavaScript("document.body ? document.body.innerText : ''", false);
    return { ok: true, text: typeof t === "string" ? t : "" };
  } catch (e) {
    return { ok: false, error: `读取页面失败：${(e as Error).message}` };
  }
}

function closeSurfaces(): void {
  destroyEmbedded();
  destroyPopup();
}

export function close(): void {
  closeSurfaces();
  // The popup choice applies to the page it was made for; forget it now so the
  // next agent open lands back in the main window.
  setRuntimeMode("embedded");
  emit();
}

/**
 * User-driven switch between the pane and a popup window for the page on
 * screen. Deliberately not persisted: the user picks the surface for *this*
 * page, not for everything the agent opens later.
 */
export async function setMode(win: BrowserWindow, mode: BrowserMode): Promise<BrowserState> {
  const url = liveWebContents()?.getURL() ?? "";
  closeSurfaces();
  setRuntimeMode(mode);
  if (url) await open(win, url);
  else emit();
  return state();
}

export function shutdown(): void {
  closeSurfaces();
}
