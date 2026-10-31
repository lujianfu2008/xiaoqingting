import type { BrowserWindow, WebContents } from "electron";

// Windows/webContents can be destroyed between grabbing a reference and using
// it (fast close, tray quit, language switch during teardown) — and on a dead
// object even property getters (.webContents) throw "Object has been
// destroyed". Every main→renderer send goes through safeSend so that never
// surfaces as an uncaught TypeError.

/** Send to a renderer; returns false (instead of throwing) when unusable. */
export function safeSend(
  wc: WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, ...args);
      return true;
    }
  } catch {
    // destroyed mid-send; nothing to deliver
  }
  return false;
}

/** True when the window and its webContents are both still usable. */
export function windowAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  try {
    return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
  } catch {
    return false;
  }
}
