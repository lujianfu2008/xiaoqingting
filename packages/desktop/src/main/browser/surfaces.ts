import { BrowserWindow, WebContentsView, shell } from "electron";
import { loadSettings } from "../settings";
import { uiStrings } from "../i18n";

// Browser surfaces: the embedded WebContentsView docked in the main window and
// the popup BrowserWindow. Only one is alive at a time. Also owns the state
// broadcast and the renderer-reported bounds.

export type BrowserMode = "embedded" | "popup";

export interface BrowserState {
  mode: BrowserMode;
  open: boolean;
  url: string;
  title: string;
}

let embedded: WebContentsView | null = null;
let popup: BrowserWindow | null = null;
let host: BrowserWindow | null = null;
// Where pages render *right now*. Agent-driven opens always embed; only the
// user's 弹窗 button moves the current page out, and it lasts until the page
// is closed — never a persisted default (that made one stray click send every
// later agent open to a popup the user never asked for).
let runtimeMode: BrowserMode = "embedded";
// Last rect the renderer reported (content-area DIP). Zero width = hidden.
let bounds = { x: 0, y: 0, width: 0, height: 0 };

export function browserMode(): BrowserMode {
  return runtimeMode;
}

export function setRuntimeMode(mode: BrowserMode): void {
  runtimeMode = mode;
}

export function emit(): void {
  const s = state();
  if (host && !host.isDestroyed()) host.webContents.send("blm:browser:state", s);
  if (popup && !popup.isDestroyed()) popup.webContents.send("blm:browser:state", s);
}

export function liveWebContents(): Electron.WebContents | null {
  if (embedded && !embedded.webContents.isDestroyed()) return embedded.webContents;
  if (popup && !popup.isDestroyed()) return popup.webContents;
  return null;
}

export function state(): BrowserState {
  const wc = liveWebContents();
  return {
    mode: browserMode(),
    open: wc !== null,
    url: wc ? wc.getURL() : "",
    title: wc ? wc.getTitle() : "",
  };
}

function attachToEmbedded(win: BrowserWindow): WebContentsView {
  if (embedded && !embedded.webContents.isDestroyed()) {
    if (host !== win) {
      host?.contentView.removeChildView(embedded);
      host = win;
      win.contentView.addChildView(embedded);
    }
    return embedded;
  }
  host = win;
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  embedded = view;
  wire(view.webContents);
  win.contentView.addChildView(view);
  view.setBounds({ ...bounds });
  return view;
}

function wire(wc: Electron.WebContents): void {
  const refresh = (): void => emit();
  wc.on("did-navigate", refresh);
  wc.on("did-navigate-in-page", refresh);
  wc.on("page-title-updated", refresh);
  wc.on("did-fail-load", refresh);
  wc.on("destroyed", () => {
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

/** Dock the embedded view at the renderer-reported rect (0 size = hidden). */
export function setBounds(win: BrowserWindow, rect: { x: number; y: number; width: number; height: number }): void {
  const next = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  const same =
    next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height;
  bounds = next;
  if (embedded && !embedded.webContents.isDestroyed()) {
    if (host !== win) {
      host?.contentView.removeChildView(embedded);
      host = win;
      win.contentView.addChildView(embedded);
    }
    if (!same) embedded.setBounds({ ...bounds });
  }
}

export function destroyEmbedded(): void {
  if (!embedded) return;
  try {
    host?.contentView.removeChildView(embedded);
  } catch {
    // window gone already
  }
  if (!embedded.webContents.isDestroyed()) embedded.webContents.close();
  embedded = null;
}

export function destroyPopup(): void {
  if (!popup) return;
  if (!popup.isDestroyed()) popup.destroy();
  popup = null;
}

export function ensureSurface(win: BrowserWindow): Electron.WebContents {
  if (browserMode() === "popup") {
    destroyEmbedded();
    if (!popup || popup.isDestroyed()) {
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
        // Closing the popup ends the popup choice; the next open embeds again.
        runtimeMode = "embedded";
        emit();
      });
    }
    return popup.webContents;
  }
  destroyPopup();
  return attachToEmbedded(win).webContents;
}

export function registerHost(win: BrowserWindow): void {
  host = win;
}

/** Re-apply the last reported rect (called when the window resizes). */
export function relayout(win: BrowserWindow): void {
  if (!embedded || embedded.webContents.isDestroyed()) return;
  if (host !== win) return;
  embedded.setBounds({ ...bounds });
}

/** Window is going away: drop the view without closing the webContents. */
export function detach(): void {
  if (embedded && host && !host.isDestroyed()) {
    try {
      host.contentView.removeChildView(embedded);
    } catch {
      // already detached
    }
  }
}
