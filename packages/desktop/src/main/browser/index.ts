import type { BrowserWindow } from "electron";
import {
  type BrowserMode,
  type BrowserState,
  closeActive,
  closeSession,
  open as surfaceOpen,
  setMode as surfaceSetMode,
  shutdown as surfaceShutdown,
  snapshot as surfaceSnapshot,
  state,
} from "./surfaces";

// Built-in browser used by the agent's browser_* tools. Pages are
// per-session: each session tab gets its own view, and only the
// focused tab's page is on screen — switching tabs must never
// show another session's browser. The surfaces live in ./surfaces.
//
// Rule: anything the *agent* opens is embedded in the main window
// (page right, chat in the middle). A popup is opt-in per page —
// the 弹窗 button in the pane bar switches only the page currently
// on screen, and the next open embeds again.

export type { BrowserMode, BrowserState } from "./surfaces";
export {
  forgetSession,
  registerHost,
  relayout,
  setActiveSession,
  setBounds,
  state,
} from "./surfaces";

export async function open(
  win: BrowserWindow,
  url: string,
  sessionId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  return surfaceOpen(win, url, sessionId ?? null);
}

export async function snapshot(
  sessionId?: string | null,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  return surfaceSnapshot(sessionId ?? null);
}

/** Agent-driven close of the calling session's page. */
export function close(sessionId?: string | null): void {
  closeSession(sessionId ?? null);
}

/** Pane ✕: close the focused tab's page. */
export function closeFocused(): void {
  closeActive();
}

/**
 * User-driven switch between the pane and a popup window for the
 * page on screen. Deliberately not persisted: the user picks the
 * surface for *this* page, not for everything the agent opens later.
 */
export async function setMode(
  win: BrowserWindow,
  mode: BrowserMode,
  sessionId?: string | null,
): Promise<BrowserState> {
  return surfaceSetMode(win, mode, sessionId ?? null);
}

/** Window/app teardown: drop every page. */
export function shutdown(): void {
  surfaceShutdown();
}
