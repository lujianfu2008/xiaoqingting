import type { BrowserWindow } from "electron";
import { dialog } from "electron";import fs from "node:fs";
import path from "node:path";
import { loadSettings, patchSettings } from "../settings";
import { uiStrings } from "../i18n";

// The agent's work dir: every file/command action is confined to it. It is
// stored in settings.json and picked through a native directory dialog.

export function loadWorkDir(): string | null {
  return loadSettings().workDir;
}

function saveWorkDir(dir: string): void {
  patchSettings({ workDir: dir });
}

function dialogOpts(): Electron.OpenDialogOptions {
  const s = uiStrings(loadSettings().language);
  return {
    title: s.workdirTitle,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: s.workdirButton,
  };
}

/** Always ask the user to pick a work dir (used by the settings UI / agent). */
export async function chooseWorkDir(win: BrowserWindow): Promise<string | null> {
  const res = await dialog.showOpenDialog(win, dialogOpts());
  if (res.canceled || res.filePaths.length === 0) return null;
  saveWorkDir(res.filePaths[0]);
  return res.filePaths[0];
}

export async function ensureWorkDir(win: BrowserWindow): Promise<string | null> {
  let dir = loadWorkDir();
  if (dir && fs.existsSync(dir)) return dir;
  const res = await dialog.showOpenDialog(win, dialogOpts());
  if (res.canceled || res.filePaths.length === 0) return null;
  dir = res.filePaths[0];
  saveWorkDir(dir);
  return dir;
}

/** Resolve a user-provided path against the work dir and prevent escaping it. */
export function resolveSafe(workDir: string, p: string): string | null {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workDir, p);
  const normWork = path.resolve(workDir);
  const rel = path.relative(normWork, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}
