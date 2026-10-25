import { app, Menu, Notification, Tray, type BrowserWindow } from "electron";
import path from "node:path";
import { uiStrings } from "./i18n";
import { loadSettings } from "./settings";

// System tray: created the first time ✕ hides the window (关闭按钮行为=托盘).
// Left-click restores the window; the context menu always offers a real quit.

let tray: Tray | null = null;
let hideNotified = false;

/** Multi-size .ico ships via extraResources (packaged) or build/ (dev).
 *  Passing the path straight to Tray lets Windows pick the right size per DPI. */
function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "../../build/icon.ico");
}

function restore(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function ensureTray(win: BrowserWindow): void {
  if (tray) return;
  const s = uiStrings(loadSettings().language);
  tray = new Tray(trayIconPath());
  tray.setToolTip(s.trayTip);
  tray.on("click", () => restore(win));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.trayOpen, click: () => restore(win) },
      { type: "separator" },
      { label: s.trayQuit, click: () => app.quit() },
    ]),
  );
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** Hide to tray on ✕; returns true when the close was intercepted. */
export function closeToTray(win: BrowserWindow): boolean {
  if (loadSettings().closeAction !== "tray") return false;
  win.hide();
  ensureTray(win);
  if (!hideNotified) {
    hideNotified = true;
    const s = uiStrings(loadSettings().language);
    new Notification({ title: s.trayTip, body: s.trayNotifyBody }).show();
  }
  return true;
}
