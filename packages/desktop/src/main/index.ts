import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { executeLocal } from "./executor";
import { markAttachments, previewAttachment, saveAttachment } from "./attachments";
import {
  ACCESS_MODES,
  accessScopeState,
  addAccessFolder,
  removeAccessFolder,
  setAccessMode,
  setProjectAccessMode,
  type AccessMode,
} from "./executor/accessScope";
import {
  bindProjectFolder,
  forgetSession,
  getProjectFolder,
  setSessionProject,
} from "./executor/projectFolders";
import { synthesizeSpeech, stopSpeaking, listVoices } from "./tts";
import { transcribePcm } from "./asr";
import { applyAppMenu } from "./menu";
import { resolveLanguage } from "./i18n";
import { currentLanguage } from "./menu";
import { closeToTray, destroyTray } from "./tray";
import { acquireLogin, isAccountLocked, releaseLogin } from "./loginLock";
import { loadSettings, patchSettings, type CloseAction } from "./settings";
import * as browser from "./browser";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "小蜻蜓",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("page-title-updated", (e) => e.preventDefault());

  // ✕ and — are interceptable: 设置→关闭按钮行为=托盘 sends both to the tray
  // instead. before-quit raises the flag so 菜单退出/托盘退出 close for real.
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  const toTray = (): boolean => !quitting && closeToTray(win);
  win.on("close", (e) => {
    if (toTray()) e.preventDefault();
  });
  // Electron's typings give minimize's listener no event param, but the runtime
  // does pass it — cast so we can preventDefault (same intercept as ✕).
  win.on("minimize", ((e: Electron.Event) => {
    if (toTray()) e.preventDefault();
  }) as () => void);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  browser.registerHost(win);
  // Re-dock the browser view when the window resizes under it.
  win.on("resize", () => browser.relayout(win));
  win.on("closed", () => browser.close());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  // Required on Windows for Notification toasts (托盘最小化提示).
  app.setAppUserModelId("com.bailongma.desktop");

  // Localized application menu (语言 switcher rebuilds it live).
  applyAppMenu();

  // Local action executor: the renderer forwards server requests here via IPC.
  ipcMain.handle(
    "blm:exec",
    async (
      event,
      req: { action: string; params: Record<string, unknown>; session_id?: string },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !req || typeof req.action !== "string") {
        return { ok: false, error: "无效请求" };
      }
      return executeLocal(win, {
        action: req.action,
        params: req.params ?? {},
        session_id: typeof req.session_id === "string" ? req.session_id : undefined,
      });
    },
  );

  // Project folder bindings (renderer-only actions — these names are not in
  // the WS protocol's action enum, so the server/agent can never invoke them).
  ipcMain.handle(
    "blm:projects:bind",
    async (
      event,
      args: { project_id: string; name?: string; choose: boolean },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !args || typeof args.project_id !== "string") {
        return { ok: false, error: "无效请求" };
      }
      return bindProjectFolder(win, args.project_id, {
        name: typeof args.name === "string" ? args.name : undefined,
        choose: args.choose !== false,
        autoFallback: true,
      });
    },
  );
  ipcMain.handle("blm:projects:getFolder", (_e, args: { project_id: string }) => ({
    folder:
      args && typeof args.project_id === "string"
        ? getProjectFolder(args.project_id)
        : null,
  }));
  ipcMain.handle("blm:session:setProject", (_e, args: { session_id: string; project_id: string | null }) => {
    if (args && typeof args.session_id === "string") {
      setSessionProject(
        args.session_id,
        typeof args.project_id === "string" ? args.project_id : null,
      );
    }
  });
  ipcMain.handle("blm:session:forget", (_e, args: { session_id: string }) => {
    if (args && typeof args.session_id === "string") forgetSession(args.session_id);
  });
  // Attachments: clipboard/pasted files are saved from the renderer into the
  // per-session attachment store; preview returns a small thumbnail dataURL.
  // Renderer-only channels (like access:*), never in the WS action enum.
  ipcMain.handle(
    "blm:attachments:save",
    async (_e, args: { session_id: string; name: string; bytes: Uint8Array }) => {
      if (
        !args ||
        typeof args.session_id !== "string" ||
        typeof args.name !== "string" ||
        !(args.bytes instanceof Uint8Array)
      ) {
        return { error: "无效请求" };
      }
      try {
        return { path: await saveAttachment(args.session_id, args.bytes, args.name) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  );
  ipcMain.handle("blm:attachments:preview", (_e, args: { path: string }) => {
    if (!args || typeof args.path !== "string") return { error: "无效请求" };
    return previewAttachment(args.path);
  });

  // Renderer marks the paths it is about to send as [附件] lines (files kept
  // at their original location); read_attachment exempts them from the scope.
  ipcMain.handle(
    "blm:attachments:mark",
    (_e, args: { session_id: string; paths: string[] }) => {
      if (!args || typeof args.session_id !== "string" || !Array.isArray(args.paths)) return;
      markAttachments(
        args.session_id,
        args.paths.filter((p): p is string => typeof p === "string"),
      );
    },
  );

  // Access-scope policy (renderer-only — not in the WS action enum, so the
  // agent can never change what it is allowed to read). Handlers take an
  // optional project_id: with one, mode means that project's override.
  ipcMain.handle("blm:menu:getLanguage", () => resolveLanguage(currentLanguage()));

  // Local single-login lock: refuse a second simultaneous login of the same
  // account in another instance of the app on this machine (main/loginLock.ts).
  ipcMain.handle("blm:login:check", (_e, args: { user_or_eid?: string }) => ({
    locked: isAccountLocked(String(args?.user_or_eid ?? "")),
  }));
  ipcMain.handle("blm:login:acquire", (_e, args: { employee_id?: string; username?: string }) => {
    acquireLogin(String(args?.employee_id ?? ""), String(args?.username ?? ""));
  });
  ipcMain.handle("blm:login:release", () => releaseLogin());

  // Window-close behavior (退出 / 最小化到托盘), edited in 设置 → 常规.
  ipcMain.handle("blm:app:getPrefs", () => ({ closeAction: loadSettings().closeAction }));
  ipcMain.handle("blm:app:setCloseAction", (_e, v: string) => {
    if (v === "quit" || v === "tray") {
      patchSettings({ closeAction: v as CloseAction });
      if (v === "quit") destroyTray();
    }
    return loadSettings().closeAction;
  });

  ipcMain.handle("blm:access:get", (_e, args?: { project_id?: string }) =>
    accessScopeState(args?.project_id ?? null),
  );
  ipcMain.handle(
    "blm:access:setMode",
    (_e, args: { mode: string; project_id?: string | null }) => {
      if (!args || !ACCESS_MODES.some((m) => m.id === args.mode)) return accessScopeState(null);
      const mode = args.mode as AccessMode;
      if (args.project_id) setProjectAccessMode(args.project_id, mode);
      else setAccessMode(mode);
      return accessScopeState(args.project_id ?? null);
    },
  );
  ipcMain.handle("blm:access:setProjectMode", (_e, args: { project_id: string; mode: string | null }) => {
    if (args && typeof args.project_id === "string") {
      const mode = args.mode;
      if (mode === null) setProjectAccessMode(args.project_id, null);
      else if (ACCESS_MODES.some((m) => m.id === mode)) {
        setProjectAccessMode(args.project_id, mode as AccessMode);
      }
    }
    return accessScopeState(args?.project_id ?? null);
  });
  ipcMain.handle("blm:access:addFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ...accessScopeState(null), folder: null };
    const folder = await addAccessFolder(win);
    return { ...accessScopeState(null), folder };
  });
  ipcMain.handle(
    "blm:access:removeFolder",
    (_e, args: { folder: string }) => {
      if (args && typeof args.folder === "string") removeAccessFolder(args.folder);
      return accessScopeState();
    },
  );

  // Local TTS (Windows SAPI): renderer asks main to synthesize a WAV, plays it
  // itself through Web Audio so the avatar can lip-sync to the real signal.
  ipcMain.handle(
    "blm:tts:speak",
    (_e, args: { text: string; opts?: { voice?: string; rate?: number; volume?: number } }) => {
      if (!args || typeof args.text !== "string") return { error: "无效请求" };
      return synthesizeSpeech(args.text, args.opts ?? {});
    },
  );
  ipcMain.handle("blm:tts:stop", () => stopSpeaking());
  ipcMain.handle("blm:tts:voices", () => listVoices());

  // Built-in browser: the renderer reports the pane rect for the embedded
  // WebContentsView and can switch between embedded / popup rendering.
  ipcMain.handle("blm:browser:state", () => browser.state());
  ipcMain.handle(
    "blm:browser:setBounds",
    (event, rect: { x: number; y: number; width: number; height: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && rect) browser.setBounds(win, rect);
    },
  );
  ipcMain.handle("blm:browser:setMode", async (event, mode: "embedded" | "popup") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || (mode !== "embedded" && mode !== "popup")) return browser.state();
    return browser.setMode(win, mode);
  });
  ipcMain.handle("blm:browser:open", async (event, url: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof url !== "string") return { ok: false, error: "无效请求" };
    return browser.open(win, url);
  });
  ipcMain.handle("blm:browser:close", () => browser.close());

  // Local offline ASR: renderer sends 16kHz mono int16 PCM from the mic;
  // recognition runs in a standalone-Node child process (see asr.ts).
  ipcMain.handle("blm:asr:transcribe", async (_e, pcm: ArrayBuffer) => {
    if (!(pcm instanceof ArrayBuffer)) return { text: "", error: "无效音频数据" };
    try {
      return { text: await transcribePcm(pcm) };
    } catch (e) {
      return { text: "", error: e instanceof Error ? e.message : "语音识别失败" };
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  releaseLogin();
  destroyTray();
  browser.shutdown();
});
