import type { BrowserWindow } from "electron";
import fs from "node:fs";
import { BROWSER_ACTIONS, runBrowserAction } from "./browserActions";
import type { ExecOutcome } from "./limits";
import { listDir, readAttachment, readFile, runCommand, writeFile } from "./fileOps";
import { chooseWorkDir, ensureWorkDir } from "./workdir";
import { describeAccessScope } from "./accessScope";
import { bindProjectFolder, effectiveWorkDir, sessionProjectOf } from "./projectFolders";

// Local executor: runs on the user's machine in the Electron main process.
// Receives generic actions (run_command / file ops / built-in browser) via IPC
// from the renderer, which forwards them over WebSocket to the server.

export type { ExecOutcome } from "./limits";

export interface ExecRequest {
  action: string;
  params: Record<string, unknown>;
  // Lets project-bound sessions resolve their own work dir (one folder per
  // project); sessions in the default space fall back to the global work dir.
  session_id?: string;
}

export async function executeLocal(
  win: BrowserWindow,
  req: ExecRequest,
): Promise<ExecOutcome> {
  const { action, params, session_id } = req;

  // Browser actions don't need a work dir.
  if (BROWSER_ACTIONS.has(action)) {
    return runBrowserAction(win, action, params);
  }

  // The session's project decides both its work dir and its read-scope mode.
  const projectId = sessionProjectOf(session_id);

  // Work-dir info/actions never prompt for the directory themselves.
  switch (action) {
    case "get_workdir": {
      const dir = effectiveWorkDir(session_id);
      if (!dir || !fs.existsSync(dir)) {
        return { ok: true, output: "（尚未设置工作目录）" };
      }
      // Second line tells the agent what the current read scope is, so it can
      // tell workspace-external reads apart from denied ones.
      return { ok: true, output: `${dir}\n访问范围：${describeAccessScope(projectId)}` };
    }
    case "choose_workdir": {
      // Inside a project session this re-binds the whole project's folder
      // (sibling sessions follow); otherwise it changes the global work dir.
      if (projectId) {
        const r = await bindProjectFolder(win, projectId, {
          choose: true,
          autoFallback: false,
        });
        if (!r.ok) return { ok: false, error: r.error ?? "绑定失败。" };
        return { ok: true, output: `项目工作目录已设为 ${r.folder}` };
      }
      const dir = await chooseWorkDir(win);
      if (!dir) return { ok: false, error: "用户取消了选择。" };
      return { ok: true, output: `工作目录已设为 ${dir}` };
    }
case "read_attachment": {
// Attachment reads don't need a work dir: pasted/marked files are always
// readable; other paths still go through the read scope.
return readAttachment(
String(params.path ?? ""),
params.mode === "ocr" ? "ocr" : "image",
effectiveWorkDir(session_id),
session_id,
projectId,
);
}
  }

  // File/command actions operate inside the session's work dir (project
  // folder when bound, else the global one).
  const workDir = effectiveWorkDir(session_id) ?? (await ensureWorkDir(win));
  if (!workDir) return { ok: false, error: "用户未选择工作目录，操作已取消。" };

  switch (action) {
    case "run_command":
      return runCommand(String(params.command ?? ""), workDir);
    case "read_file":
      return readFile(workDir, String(params.path ?? ""), projectId);
    case "write_file":
      return writeFile(workDir, String(params.path ?? ""), String(params.content ?? ""));
    case "list_dir":
      return listDir(workDir, String(params.path ?? "."), projectId);
    default:
      return { ok: false, error: `未知操作：${action}` };
  }
}
