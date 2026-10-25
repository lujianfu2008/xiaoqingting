import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, patchSettings } from "../settings";
import { uiStrings } from "../i18n";
import { loadWorkDir } from "./workdir";

// Per-project local folders: each project binds one folder on this machine and
// every file/command action of its sessions is confined to it (the default
// space keeps using the global work dir). Bindings live only in this desktop's
// settings.json; the server stores just the grouping (project_id), never paths.

// Runtime session -> project mapping. The renderer keeps it in sync over IPC
// (session create/select/list-load); it is rebuilt after an app restart.
const sessionProjects = new Map<string, string | null>();

export function setSessionProject(sessionId: string, projectId: string | null): void {
  if (sessionId) sessionProjects.set(sessionId, projectId ?? null);
}

export function forgetSession(sessionId: string): void {
  sessionProjects.delete(sessionId);
}

/** The project a session belongs to (even when its folder is not bound yet). */
export function sessionProjectOf(sessionId: string | undefined): string | null {
  return sessionId ? (sessionProjects.get(sessionId) ?? null) : null;
}

/** Local folder bound to a project, or null when unbound/deleted on disk. */
export function getProjectFolder(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const dir = loadSettings().projectFolders[projectId];
  return dir && fs.existsSync(dir) ? dir : null;
}

/** Work dir for a session's local actions: its project folder, else the global one. */
export function effectiveWorkDir(sessionId: string | undefined): string | null {
  const projectId = sessionId ? (sessionProjects.get(sessionId) ?? null) : null;
  return getProjectFolder(projectId) ?? loadWorkDir();
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[/\\:*?"<>|]/g, "").trim();
  return clean || uiStrings(loadSettings().language).untitledProject;
}

/**
 * Bind a local folder to a project. With `choose` a native dialog asks first;
 * if it is skipped/canceled and `autoFallback` is set, auto-create a subfolder
 * named after the project under the global work dir instead.
 */
export async function bindProjectFolder(
  win: BrowserWindow,
  projectId: string,
  opts: { name?: string; choose: boolean; autoFallback: boolean },
): Promise<{ ok: boolean; folder?: string; error?: string }> {
  let dir: string | null = null;
  if (opts.choose) {
    const base = uiStrings(loadSettings().language);
    const s = uiStrings(loadSettings().language, {
      name: opts.name ?? base.untitledProject,
    });
    const res = await dialog.showOpenDialog(win, {
      title: s.projectFolderTitle,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: s.projectFolderButton,
    });
    if (!res.canceled && res.filePaths[0]) dir = res.filePaths[0];
    else if (!opts.autoFallback) return { ok: false, error: "用户取消了选择。" };
  }
  if (!dir) {
    const base = loadWorkDir();
    if (!base || !fs.existsSync(base)) {
      return { ok: false, error: "尚未设置默认工作目录，请先在设置中选择。" };
    }
    const baseName = sanitizeName(opts.name ?? "未命名项目");
    dir = path.join(base, baseName);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${baseName} (${i})`);
  }
  fs.mkdirSync(dir, { recursive: true });
  patchSettings({
    projectFolders: { ...loadSettings().projectFolders, [projectId]: dir },
  });
  return { ok: true, folder: dir };
}
