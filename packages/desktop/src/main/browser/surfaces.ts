import {
  BrowserWindow,
  WebContentsView,
  shell,
  nativeImage,
} from "electron";
import { loadSettings } from "../settings";
import { uiStrings } from "../i18n";
import { safeSend, windowAlive } from "../safeSend";

// Browser surfaces: one embedded WebContentsView per session that has
// opened a page, plus at most one popup window. Only the *active*
// session's (renderer-reported tab focus) view is visible — switching
// tabs must never show another session's page. Background views stay
// alive (children of the window with a zero rect) so a background
// session's agent can still open/snapshot pages, and switching back
// restores the live page without a reload.

export type BrowserMode = "embedded" | "popup";

export interface BrowserState {
  mode: BrowserMode;
  open: boolean;
  url: string;
  title: string;
  /** The session this state describes (main computes it per focused tab). */
  session_id: string;
}

const ZERO = { x: 0, y: 0, width: 0, height: 0 };
// Cap on simultaneously live pages (each is a full renderer process).
const MAX_VIEWS = 8;

let host: BrowserWindow | null = null;
// The session whose page the pane should show (renderer-reported).
let activeSession: string | null = null;
// One view per session that has opened a page; only the active one is visible.
const views = new Map<string, WebContentsView>();
const lastUsed = new Map<string, number>();
let visibleView: WebContentsView | null = null;
let popup: BrowserWindow | null = null;
let popupOwner: string | null = null;
// Last rect the renderer reported (content-area DIP). Zero width = hidden.
let bounds = ZERO;

export function emit(): void {
  const s = state();
  if (windowAlive(host)) safeSend(host.webContents, "blm:browser:state", s);
}

function wcOf(view: WebContentsView | null | undefined): Electron.WebContents | null {
  if (!view) return null;
  try {
    return view.webContents.isDestroyed() ? null : view.webContents;
  } catch {
    return null; // view already destroyed (even the getter can throw)
  }
}

/** State of the *focused* session — the pane renders exactly this. */
export function state(): BrowserState {
  const sid = activeSession ?? "";
  if (sid && popupOwner === sid && popup && !popup.isDestroyed()) {
    return {
      mode: "popup",
      open: true,
      url: popup.webContents.getURL(),
      title: popup.webContents.getTitle(),
      session_id: sid,
    };
  }
  const wc = wcOf(sid ? views.get(sid) : null);
  if (wc) {
    return { mode: "embedded", open: true, url: wc.getURL(), title: wc.getTitle(), session_id: sid };
  }
  return { mode: "embedded", open: false, url: "", title: "", session_id: sid };
}

function wire(wc: Electron.WebContents, onGone?: () => void): void {
  const refresh = (): void => emit();
  wc.on("did-navigate", refresh);
  wc.on("did-navigate-in-page", refresh);
  wc.on("page-title-updated", refresh);
  wc.on("did-fail-load", refresh);
  wc.on("destroyed", () => {
    onGone?.();
    emit();
  });
  // Keep agent-driven navigation inside the built-in browser; external links
  // would otherwise open a real OS browser the snapshot tool cannot see.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void wc.loadURL(url);
    else void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Make `view` the one visible page (or show none). Others drop to a zero rect. */
function show(view: WebContentsView | null): void {
  const prev = visibleView;
  if (prev === view) return;
  visibleView = view;
  if (prev) {
    try {
      prev.setBounds(ZERO);
    } catch {
      // gone already
    }
  }
  if (view) {
    try {
      view.setBounds({ ...bounds });
    } catch {
      // gone already
    }
  }
}

function addChild(view: WebContentsView): void {
  try {
    host?.contentView.addChildView(view);
  } catch {
    // window gone — the page still loads offscreen
  }
}

function destroyView(view: WebContentsView): void {
  if (visibleView === view) visibleView = null;
  try {
    host?.contentView.removeChildView(view);
  } catch {
    // window gone already
  }
  try {
    const wc = view.webContents;
    if (!wc.isDestroyed()) wc.close();
  } catch {
    // view gone already — even the getter can throw here
  }
}

/** Remove a session's page entirely (map entry, recency, webContents). */
function dropSession(sessionId: string): void {
  const view = views.get(sessionId);
  if (!view) return;
  views.delete(sessionId);
  lastUsed.delete(sessionId);
  destroyView(view);
}

function destroyPopup(): void {
  const p = popup;
  popup = null;
  popupOwner = null;
  if (p && !p.isDestroyed()) p.destroy();
}

function closeAllSurfaces(): void {
  for (const sid of [...views.keys()]) dropSession(sid);
  destroyPopup();
}

function evict(): void {
  while (views.size >= MAX_VIEWS) {
    let oldestSid: string | null = null;
    let oldest = Infinity;
    for (const sid of views.keys()) {
      if (sid === activeSession) continue;
      const t = lastUsed.get(sid) ?? 0;
      if (t < oldest) {
        oldest = t;
        oldestSid = sid;
      }
    }
    if (!oldestSid) break; // only the active session remains
    dropSession(oldestSid);
  }
}

function ensureView(win: BrowserWindow, sessionId: string): WebContentsView {
  const existing = views.get(sessionId);
  if (existing && wcOf(existing)) {
    lastUsed.set(sessionId, Date.now());
    return existing;
  }
  if (existing) dropSession(sessionId); // destroyed leftover — replace
  evict();
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  views.set(sessionId, view);
  lastUsed.set(sessionId, Date.now());
  wire(view.webContents, () => {
    if (views.get(sessionId) === view) {
      views.delete(sessionId);
      lastUsed.delete(sessionId);
    }
    if (visibleView === view) visibleView = null;
  });
  if (!host) host = win;
  addChild(view);
  // Visible only when it belongs to the focused tab; background pages
  // stay alive at a zero rect (agent opens/snapshots still work there).
  if (sessionId === activeSession) show(view);
  else {
    try {
      view.setBounds(ZERO);
    } catch {
      // gone already
    }
  }
  return view;
}

/**
 * The renderer focused another session tab: show that session's page
 * (kept alive from before — no reload) or collapse the pane. null =
 * nothing focused (last tab closed / logout): drop every page so one
 * can never leak across tabs or accounts.
 */
export function setActiveSession(sessionId: string | null): void {
  if (sessionId === null) {
    activeSession = null;
    closeAllSurfaces();
    emit();
    return;
  }
  if (activeSession === sessionId) return;
  activeSession = sessionId;
  lastUsed.set(sessionId, Date.now());
  const view = views.get(sessionId) ?? null;
  show(view && wcOf(view) ? view : null);
  emit();
}

export async function open(
  win: BrowserWindow,
  url: string,
  sessionId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "网址必须以 http:// 或 https:// 开头。" };
  if (!host) host = win;
  const sid = sessionId ?? activeSession ?? "";
  // The same session opening a fresh page ends its popup choice.
  if (popupOwner === sid) destroyPopup();
  const view = ensureView(win, sid);
  try {
    await view.webContents.loadURL(url);
    emit();
    return { ok: true };
  } catch (e) {
    emit();
    return { ok: false, error: `打开失败：${(e as Error).message}` };
  }
}

export async function snapshot(
  sessionId?: string | null,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const sid = sessionId ?? activeSession ?? "";
  // Every agent touch counts as recency: an agent mid-task must not
  // have its page evicted by the cap while the user chats elsewhere.
  if (sid && views.has(sid)) lastUsed.set(sid, Date.now());
  let wc = wcOf(sid ? views.get(sid) : null);
  if (!wc && sid && popupOwner === sid && popup && !popup.isDestroyed()) {
    wc = popup.webContents;
  }
  if (!wc) return { ok: false, error: "浏览器未打开。" };
  try {
    const t = await wc.executeJavaScript("document.body ? document.body.innerText : ''", false);
    return { ok: true, text: typeof t === "string" ? t : "" };
  } catch (e) {
    return { ok: false, error: `读取页面失败：${(e as Error).message}` };
  }
}

/** Close one session's page (the agent's browser_close or the pane ✕). */
export function closeSession(sessionId?: string | null): void {
  const sid = sessionId ?? activeSession ?? "";
  if (!sid) return;
  if (popupOwner === sid) destroyPopup();
  dropSession(sid);
  emit();
}

export function closeActive(): void {
  closeSession(activeSession);
}

/**
 * User-driven switch between the pane and a popup window for the
 * page on screen. Deliberately not persisted: the user picks the
 * surface for *this* page, not for everything the agent opens later.
 * There is at most one popup — whoever pops out owns it.
 */
export async function setMode(
  win: BrowserWindow,
  mode: BrowserMode,
  sessionId?: string | null,
): Promise<BrowserState> {
  const sid = sessionId ?? activeSession ?? "";
  if (mode === "popup") {
    const view = views.get(sid);
    const wc = wcOf(view);
    const url = wc ? wc.getURL() : "";
    if (!url) return state();
    destroyPopup();
    dropSession(sid);
    popup = new BrowserWindow({
      width: 1100,
      height: 750,
      title: uiStrings(loadSettings().language).browserTitle,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    wire(popup.webContents);
    popup.on("closed", () => {
      popup = null;
      popupOwner = null;
      // Closing the popup ends the popup choice; the next open embeds again.
      emit();
    });
    popupOwner = sid;
    try {
      await popup.webContents.loadURL(url);
    } catch {
      // navigations report via the wire hooks
    }
    emit();
    return state();
  }
  // Back to the pane: only meaningful for the session that popped out.
  if (popupOwner !== sid || !popup || popup.isDestroyed()) return state();
  const url = popup.webContents.getURL();
  destroyPopup();
  const view = ensureView(win, sid);
  try {
    await view.webContents.loadURL(url);
  } catch {
    // navigations report via the wire hooks
  }
  emit();
  return state();
}

/** Dock the visible view at the renderer-reported rect (0 size = hidden).
 *  force=true 跳过 same 判断：show() 切 view 时全局 bounds 可能
 *  是上一会话/上一布局的旧值，view 刚被按旧值摆过——渲染端随后
 *  的上报必须真正落到 view 上，不能被「尺寸没变」挡掉。
 *  covered=true（弹窗遮罩/拖拽临时隐藏）：记下真实几何但
 *  不摆 view（view 保持/归于隐藏）——诊断摘要用的 rect 不会
 *  被「弹窗开着」污染成 0 尺寸。 */
export function setBounds(
  win: BrowserWindow,
  rect: { x: number; y: number; width: number; height: number; covered?: boolean },
  force = false,
): void {
  const covered = rect.covered === true;
  const next = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  const same =
    next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height;
  bounds = next;
  const view = visibleView;
  if (!view || covered) {
    // covered：藏掉 view（native 图永远在遮罩之上，必须归零），
    // 但 bounds 保留真实几何供诊断。viewHidden 记下
    // 「账面 rect 未真正摆上」，viewBounds().posed 据此分辨。
    if (view && covered) {
      try {
        view.setBounds(ZERO);
      } catch {
        // gone already
      }
    }
    if (covered) viewHidden = true;
    return;
  }
  viewHidden = false;
  try {
    if (host !== win) {
      try {
        host?.contentView.removeChildView(view);
      } catch {
        // old window gone already
      }
      host = win;
      win.contentView.addChildView(view);
    }
    if (!same || force) view.setBounds({ ...bounds });
  } catch {
    // window gone already
  }
}

/** 渲染层最后一次自报的视口（CSS 尺寸 + dpr）。 */
let lastViewport: { width: number; height: number; dpr: number } | null = null;

/**
 * 高分屏 DPI 分叉检测（pane 满屏右/下空白的另一根因）：
 * 渲染层每次上报 stage rect 时顺带自报视口。主进程对照
 * 窗口内容区尺寸——理论上 CSS px 与 DIP 一一对应，两者
 * 恒等；不一致即「窗口 DPI 上下文与屏幕缩放分叉」
 * （改系统缩放后应用未重启 / 跨 DPI 屏拖动后的窗口）。
 * 分叉时按渲染层认知重设窗口内容区，让两侧坐标系重新
 * 对齐（一次性自愈，不再持续抖动）。
 */
export function noteViewport(
  win: BrowserWindow,
  vp: { width: number; height: number; dpr: number },
): void {
  lastViewport = vp;
  try {
    const content = win.getContentSize();
    if (
      Math.abs(content[0] - vp.width) <= 2 &&
      Math.abs(content[1] - vp.height) <= 2
    ) {
      return; // 一致：最常见的健康路径
    }
    // 分叉：以渲染层为准重同步。只修一次（同步后再分叉
    // 会在下一次上报再修——1s 心跳保证收口）。分叉本身
    // 不涉引擎，日志不含品牌词，直接落。
    console.warn(
      `[browser] viewport/DIP divergence: renderer ${vp.width}x${vp.height} @${vp.dpr} vs content ${content[0]}x${content[1]} — resyncing`,
    );
    win.setContentSize(vp.width, vp.height);
  } catch {
    // window gone already
  }
}

/** 诊断摘要用：渲染层视口自报值。 */
export function rendererViewport(): {
  width: number;
  height: number;
  dpr: number;
} | null {
  return lastViewport ? { ...lastViewport } : null;
}

/** Re-apply the last reported rect (called when the window resizes). */
export function relayout(win: BrowserWindow): void {
  if (host !== win || !visibleView) return;
  try {
    visibleView.setBounds({ ...bounds });
  } catch {
    // view gone already
  }
}

/** Last renderer-reported rect, plus whether the view is
 *  actually posed there right now (遮罩开着时 view 已被
 *  归零，bounds 只是「几何账面」——诊断要能分辨）。 */
export function viewBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
  posed: boolean;
} {
  return { ...bounds, posed: !viewHidden };
}

// 遮罩把可见 view 归零后置位；view 重新按 bounds 摆上时清零。
let viewHidden = false;

/**
 * 诊断截图：整窗截图（capturePage 只拍主 webContents，
 * 拍不到原生 view）+ view 页面自己的位图，把后者贴到
 * 账面摆位上合成一张。遮罩开着（view 被藏）也贴——
 * stage 是白底，贴上即「无遮罩时应有的样子」，posed=false
 * 告诉诊断页 view 当时其实被藏着。无页面时退化为纯整窗截图。
 */
export async function captureComposite(
  win: BrowserWindow,
): Promise<{ image: Electron.NativeImage; posed: boolean } | null> {
  const main = await win.webContents.capturePage();
  if (main.isEmpty()) return null;
  const view = visibleView;
  if (!view) return { image: main, posed: false };
  let page: Electron.NativeImage | null = null;
  try {
    if (!view.webContents.isDestroyed()) {
      page = await view.webContents.capturePage();
    }
  } catch {
    page = null; // view gone mid-capture
  }
  if (!page || page.isEmpty()) return { image: main, posed: false };
  // 位图合成：两端都来自本机 toBitmap()，格式天然一致；
  // 只做行拷贝再 createFromBitmap 回去。
  const scaleFactors = main.getScaleFactors().filter((s) => s > 1);
  const sf = scaleFactors.length > 0 ? scaleFactors[scaleFactors.length - 1] : 1;
  const mw = main.getSize().width, mh = main.getSize().height;
  const vw = page.getSize().width, vh = page.getSize().height;
  const px = Math.round(bounds.x * sf), py = Math.round(bounds.y * sf);
  let mbuf: Buffer, vbuf: Buffer;
  try {
    mbuf = main.toBitmap({ scaleFactor: sf });
    vbuf = page.toBitmap({ scaleFactor: sf });
  } catch {
    return { image: main, posed: false };
  }
  if (mbuf.length < mh * mw * 4 || vbuf.length < vh * vw * 4) {
    return { image: main, posed: false };
  }
  // 贴回前先把 view 区域裁进画面范围（部分出窗就只贴窗内）。
  const copyW = Math.min(vw, mw - px), copyH = Math.min(vh, mh - py);
  if (copyW <= 0 || copyH <= 0) return { image: main, posed: false };
  for (let row = 0; row < copyH; row++) {
    const src = row * vw * 4;
    const dst = (py + row) * mw * 4 + px * 4;
    vbuf.copy(mbuf, dst, src, src + copyW * 4);
  }
  try {
    const image = nativeImage.createFromBitmap(mbuf, {
      width: mw,
      height: mh,
      scaleFactor: sf,
    });
    return { image, posed: !viewHidden };
  } catch {
    return { image: main, posed: !viewHidden };
  }
}

export function registerHost(win: BrowserWindow): void {
  host = win;
}

/** A session was deleted on the server: its page must not linger. */
export function forgetSession(sessionId: string): void {
  if (!views.has(sessionId) && popupOwner !== sessionId) return;
  if (popupOwner === sessionId) destroyPopup();
  dropSession(sessionId);
  emit();
}

/** Window/app teardown: drop every page. */
export function shutdown(): void {
  activeSession = null;
  closeAllSurfaces();
}
