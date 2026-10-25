import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// Persisted desktop preferences (userData/settings.json). Kept in one module so
// the work-dir and browser settings never overwrite each other.

export type AccessMode = "workspace" | "full" | "custom";
export type Language = "system" | "zh-CN" | "en";
export type CloseAction = "quit" | "tray";

/** One live login on THIS machine (see main/loginLock.ts). */
export interface ActiveLogin {
  employee_id: string;
  username: string;
  pid: number;
  updated_at: number;
}

export interface DesktopSettings {
  workDir: string | null;
  // projectId -> local folder on THIS machine. Bindings never leave the
  // desktop: the server may be remote and must not learn local paths.
  projectFolders: Record<string, string>;
  // Read-scope policy: "workspace" (default) confines reads to the work dir;
  // "full" allows reading anywhere on this machine; "custom" also allows the
  // extra folders in accessFolders. Writes/deletes stay workspace-only in
  // every mode. A project may override the global mode via projectAccessModes.
  accessMode: AccessMode;
  accessFolders: string[];
  // projectId -> per-project override; absent = follow the global accessMode.
  projectAccessModes: Record<string, AccessMode>;
  // UI language for the application menu; "system" follows the OS locale.
  language: Language;
  // What the titlebar ✕ does: quit the app, or hide to the system tray.
  closeAction: CloseAction;
  // Live logins on this machine, for blocking a second simultaneous login of
  // the same account in another app instance (main/loginLock.ts owns it).
  activeLogins: ActiveLogin[];
}

let settingsPath: string | null = null;

function settingsFile(): string {
  if (!settingsPath) settingsPath = path.join(app.getPath("userData"), "settings.json");
  return settingsPath;
}

export function loadSettings(): DesktopSettings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
    return {
      workDir: typeof s.workDir === "string" ? s.workDir : null,
      projectFolders:
        s.projectFolders && typeof s.projectFolders === "object"
          ? (s.projectFolders as Record<string, string>)
          : {},
      accessMode: s.accessMode === "full" || s.accessMode === "custom" ? s.accessMode : "workspace",
      accessFolders: Array.isArray(s.accessFolders)
        ? s.accessFolders.filter((f): f is string => typeof f === "string")
        : [],
      projectAccessModes: (() => {
        if (!s.projectAccessModes || typeof s.projectAccessModes !== "object") return {};
        const out: Record<string, AccessMode> = {};
        for (const [k, v] of Object.entries(s.projectAccessModes as Record<string, unknown>)) {
          if (v === "workspace" || v === "full" || v === "custom") out[k] = v;
        }
        return out;
      })(),
      language: s.language === "zh-CN" || s.language === "en" ? s.language : "system",
      closeAction: s.closeAction === "tray" ? "tray" : "quit",
      activeLogins: (Array.isArray(s.activeLogins) ? s.activeLogins : []).filter(
        (l): l is ActiveLogin =>
          !!l &&
          typeof l === "object" &&
          typeof (l as ActiveLogin).employee_id === "string" &&
          typeof (l as ActiveLogin).username === "string" &&
          typeof (l as ActiveLogin).pid === "number" &&
          typeof (l as ActiveLogin).updated_at === "number",
      ),
    };
  } catch {
    return {
      workDir: null,
      projectFolders: {},
      accessMode: "workspace",
      accessFolders: [],
      projectAccessModes: {},
      language: "system",
      closeAction: "quit",
      activeLogins: [],
    };
  }
}

export function patchSettings(patch: Partial<DesktopSettings>): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    // non-fatal
  }
}
