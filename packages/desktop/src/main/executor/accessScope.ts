import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { uiStrings } from "../i18n";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, patchSettings, type AccessMode } from "../settings";
import { loadWorkDir } from "./workdir";

// Read-scope policy for the local executor. The agent may read beyond the
// workspace only when the user opted in (完全空间 / 自定义空间); writes and
// deletes stay confined to the workspace in every mode. The mode and extra
// folder list live only in this desktop's settings.json — the server never
// learns them, it just sees read failures / the get_workdir summary.

export type { AccessMode };

export const ACCESS_MODES: { id: AccessMode; label: string; hint: string }[] = [
  {
    id: "workspace",
    label: "工作空间",
    hint: "所有读写都限制在工作目录（项目文件夹 / 默认工作目录）内。",
  },
  {
    id: "full",
    label: "完全空间",
    hint: "可读取本机任意位置的文件和目录；写入/删除仍仅限工作目录内。",
  },
  {
    id: "custom",
    label: "自定义空间",
    hint: "除工作目录外，还可读取下方添加的文件夹；写入/删除仍仅限工作目录内。",
  },
];

export function accessMode(): AccessMode {
  return loadSettings().accessMode;
}

export function setAccessMode(mode: AccessMode): void {
  patchSettings({ accessMode: mode });
}

/** A project's own override, or null when it follows the global mode. */
export function projectAccessModeOf(projectId: string | null | undefined): AccessMode | null {
  if (!projectId) return null;
  return loadSettings().projectAccessModes[projectId] ?? null;
}

export function setProjectAccessMode(projectId: string, mode: AccessMode | null): void {
  const modes = loadSettings().projectAccessModes;
  if (mode) modes[projectId] = mode;
  else delete modes[projectId];
  patchSettings({ projectAccessModes: modes });
}

/** Effective mode for a session's project: its override, else the global one. */
export function accessModeFor(projectId: string | null | undefined): AccessMode {
  return projectAccessModeOf(projectId) ?? accessMode();
}

export function accessFolders(): string[] {
  return loadSettings().accessFolders;
}

/** Open a native picker and add the chosen folder to the extra readable list. */
export async function addAccessFolder(win: BrowserWindow): Promise<string | null> {
  const s = uiStrings(loadSettings().language);
  const res = await dialog.showOpenDialog(win, {
    title: s.accessFolderTitle,
    properties: ["openDirectory"],
    buttonLabel: s.accessFolderButton,
  });
  const dir = res.canceled ? null : (res.filePaths[0] ?? null);
  if (!dir || !fs.existsSync(dir)) return null;
  const folders = accessFolders();
  if (!folders.includes(dir)) patchSettings({ accessFolders: [...folders, dir] });
  return dir;
}

export function removeAccessFolder(dir: string): string[] {
  const folders = accessFolders().filter((f) => f !== dir);
  patchSettings({ accessFolders: folders });
  return folders;
}

/** Current state, for the settings UI. With `projectId`, `mode` is that
 *  project's effective mode and `projectMode` is its override (null = 全局). */
export function accessScopeState(projectId?: string | null): {
  workDir: string | null;
  mode: AccessMode;
  folders: string[];
  projectMode?: AccessMode | null;
} {
  const base = {
    workDir: loadWorkDir(),
    mode: accessModeFor(projectId),
    folders: accessFolders(),
  };
  return projectId ? { ...base, projectMode: projectAccessModeOf(projectId) } : base;
}

/** True when `abs` is `root` itself or inside it (lexical, like resolveSafe). */
function within(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a requested path for a read/list action. Relative paths resolve
 * against the workspace and are always allowed; workspace-external absolute
 * paths are gated by the access mode (null = 不可读).
 */
export function resolveReadable(
  workDir: string,
  p: string,
  projectId?: string | null,
): string | null {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workDir, p);
  if (within(workDir, abs)) return abs;
  switch (accessModeFor(projectId)) {
    case "full":
      return abs;
    case "custom":
      return accessFolders().some((f) => fs.existsSync(f) && within(f, abs)) ? abs : null;
    default:
      return null;
  }
}

/** One-line human-readable summary, shown to the agent by get_workdir. */
export function describeAccessScope(projectId?: string | null): string {
  switch (accessModeFor(projectId)) {
    case "full":
      return "完全空间 —— 可读取本机任意位置的文件/目录，写入/删除仅限工作目录内";
    case "custom": {
      const folders = accessFolders();
      return folders.length
        ? `自定义空间 —— 工作目录及以下文件夹可读（写入/删除仅限工作目录内）：${folders.join("、")}`
        : "自定义空间 —— 尚未添加额外文件夹，目前等同工作空间；写入/删除仅限工作目录内";
    }
    default:
      return "工作空间 —— 所有读写均限于工作目录内";
  }
}
