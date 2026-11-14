import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import { executeLocal } from "./executor";
import { markAttachments, previewAttachment, saveAttachment } from "./attachments";
import { ExportChatRequest, RelayConfigure, type ExportChatResult } from "@blm/protocol";
import { relayClient } from "./relay";
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
import { configureWake, feedWakeChunk, stopWakeStream } from "./wake";
import { applyAppMenu, setLanguage } from "./menu";
import { resolveLanguage } from "./i18n";
import { currentLanguage } from "./menu";
import { closeToTray, destroyTray, trayIconPath } from "./tray";
import { bindUpdater, checkNow } from "./updater";
import { acquireLogin, isAccountLocked, releaseLogin } from "./loginLock";
import { loadSettings, patchSettings, type CloseAction } from "./settings";
import { safeSend } from "./safeSend";
import * as browser from "./browser";
import { registerViewerIpc, registerViewerPrivileges } from "./viewer";

// viewer:// 自定义协议的 privileges 必须在 app ready 前注册。
registerViewerPrivileges();

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
      // 语音唤醒要在窗口隐藏进托盘后持续采音，不能被后台节流。
      backgroundThrottling: false,
    },
  });

  win.on("page-title-updated", (e) => e.preventDefault());

  // 只有 ✕ 可拦截：设置→关闭按钮行为=托盘 时点关闭进托盘。最小化不拦截：
  // — 始终正常缩到任务栏（拦截的话任务栏点击/Win+D 都会"消失"进托盘）。
  // before-quit raises the flag so 菜单退出/托盘退出 close for real.
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });
  win.on("close", (e) => {
    if (!quitting && closeToTray(win)) e.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  browser.registerHost(win);
  // Re-dock the browser view when the window resizes under it.
  win.on("resize", () => browser.relayout(win));
  win.on("closed", () => browser.shutdown());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

// 不加单实例锁：同机多实例登不同账号是协作流测试的标准姿势，必须保留；
// 同账号双实例的互踢风暴由 relay 客户端的 4009 让位逻辑兜住（见 relay/index.ts）。
app.whenReady().then(() => {
  // Required on Windows for Notification toasts (托盘最小化提示).
  app.setAppUserModelId("com.xiaoqingting.desktop");

  // 内置文件阅读器：viewer:// 协议 handler + 只读 IPC 通道。
  registerViewerIpc();

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
    if (args && typeof args.session_id === "string") {
      forgetSession(args.session_id);
      // 会话删除时其内置浏览器页面一并丢弃（页面按会话存）。
      browser.forgetSession(args.session_id);
    }
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

  // Renderer 侧已拼好 Markdown；这里只负责保存对话框与写盘。
  // 形状跨进程，必须经 protocol Zod 校验。
  ipcMain.handle("blm:chat:export", async (_e, args: unknown): Promise<ExportChatResult & { error?: string }> => {
    const parsed = ExportChatRequest.safeParse(args);
    if (!parsed.success) return { saved: false, path: null, error: "无效请求" };
    try {
      // 清理文件名里的非法字符（保留中文名）。
      const safe =
        parsed.data.default_filename.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 200) || "chat";
      const r = await dialog.showSaveDialog({
        defaultPath: safe.endsWith(".md") ? safe : `${safe}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (r.canceled || !r.filePath) return { saved: false, path: null };
      await fs.promises.writeFile(r.filePath, parsed.data.markdown, "utf8");
      return { saved: true, path: r.filePath };
    } catch (e) {
      return { saved: false, path: null, error: (e as Error).message };
    }
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
  // 应用内设置切换语言：走与原生菜单同一套持久化 + 广播。
  ipcMain.handle("blm:menu:setLanguage", (_e, lang: unknown) => {
    if (lang !== "system" && lang !== "zh-CN" && lang !== "en") {
      return resolveLanguage(currentLanguage());
    }
    setLanguage(lang);
    return resolveLanguage(lang);
  });

  // Local single-login lock: refuse a second simultaneous login of the same
  // account in another instance of the app on this machine (main/loginLock.ts).
  ipcMain.handle("blm:login:check", (_e, args: { user_or_eid?: string }) => ({
    locked: isAccountLocked(String(args?.user_or_eid ?? "")),
  }));
  ipcMain.handle("blm:login:acquire", (_e, args: { employee_id?: string; username?: string }) => {
    acquireLogin(String(args?.employee_id ?? ""), String(args?.username ?? ""));
  });
  ipcMain.handle("blm:login:release", () => releaseLogin());

  // 网络中继（main/relay/）：renderer 登录后把 serverUrl + JWT 下发，main 进程
  // 持有 /ws/relay 连接，把服务端发来的 llm_request 用本机网络（Electron net，
  // 自动跟随系统代理）代发并流式回传。token 只存内存、绝不写盘。
  // enabled=true 时凭证必须非空（logout 时 renderer 传空串只为断开）。
  ipcMain.handle("blm:relay:configure", (_e, args: unknown) => {
    const parsed = RelayConfigure.safeParse(args);
    if (
      !parsed.success ||
      (parsed.data.enabled && (!parsed.data.server_url.trim() || !parsed.data.token.trim()))
    ) {
      return { ok: false, error: "无效请求" };
    }
    relayClient.configure(parsed.data);
    return { ok: true };
  });
  ipcMain.handle("blm:relay:status", () => relayClient.status());

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

  // Built-in browser: the renderer reports the pane rect for the
  // focused session's WebContentsView and which tab is focused
  // (pages are per-session); it can also switch embedded / popup.
  ipcMain.handle("blm:browser:state", () => browser.state());
  ipcMain.handle(
    "blm:browser:activeSession",
    (_e, args: { session_id?: string | null }) => {
      browser.setActiveSession(
        args && typeof args.session_id === "string" && args.session_id
          ? args.session_id
          : null,
      );
    },
  );
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
  ipcMain.handle("blm:browser:close", () => browser.closeFocused());

  // Local offline ASR: renderer sends 16kHz mono int16 PCM from the mic;
  // recognition runs in a standalone-Node child process (see asr.ts).
  ipcMain.handle("blm:asr:transcribe", async (_e, pcm: ArrayBuffer, pauses?: number[]) => {
    if (!(pcm instanceof ArrayBuffer)) return { text: "", error: "无效音频数据" };
    try {
      return { text: await transcribePcm(pcm, Array.isArray(pauses) ? pauses : undefined) };
    } catch (e) {
      return { text: "", error: e instanceof Error ? e.message : "语音识别失败" };
    }
  });

  // 语音唤醒（wake.ts）：渲染端经门控后流式喂麦克风块，KeywordSpotter 在
  // 这里解码，命中即回推 blm:wake:detected。
  ipcMain.handle(
    "blm:wake:configure",
    (_e, args: { words?: unknown; sensitivity?: unknown }) => {
      if (!args || !Array.isArray(args.words)) return { error: "无效请求" };
      const words = args.words.filter((w): w is string => typeof w === "string");
      const sensitivity =
        args.sensitivity === "low" || args.sensitivity === "high" ? args.sensitivity : "medium";
      return configureWake(words, sensitivity);
    },
  );

  // 后台完成通知（renderer 判定失焦后请求）：弹系统通知，点击聚焦
  // 窗口并回传会话 id，renderer 负责跳会话。通知对象在点击/关闭后
  // 即可释放，无需长期持有。
  ipcMain.handle(
    "blm:notify:show",
    (event, args: { title?: unknown; body?: unknown; session_id?: unknown }) => {
      if (!args || typeof args.title !== "string" || !args.title.trim()) {
        return;
      }
      const sessionId =
        typeof args.session_id === "string" && args.session_id ? args.session_id : null;
      const body = typeof args.body === "string" ? args.body : "";
      const senderWc = event.sender;
      const n = new Notification({
        title: args.title.slice(0, 120),
        body: body.slice(0, 200),
        icon: trayIconPath(),
      });
      n.on("click", () => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents === senderWc,
        );
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        safeSend(senderWc, "blm:notify:activate", sessionId);
      });
      n.show();
    },
  );
  // 自动更新：renderer 登录后把服务器地址传进来绑定更新源；
  // 设置面板「检查更新」手动触发一次重查。
  ipcMain.handle(
    "blm:updater:bind",
    (_e, args: { server_url?: unknown }) => {
      if (!args || typeof args.server_url !== "string" || !args.server_url.trim()) return;
      bindUpdater(args.server_url);
    },
  );
  ipcMain.handle("blm:updater:check", () => checkNow());
  ipcMain.on("blm:wake:chunk", (event, pcm: ArrayBuffer) => {
    if (pcm instanceof ArrayBuffer) feedWakeChunk(pcm, event.sender);
  });
  ipcMain.on("blm:wake:stop", () => stopWakeStream());
  // 唤醒后把窗口从托盘/最小化拉回前台再开始语音输入。
  ipcMain.handle("blm:app:focus", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
  relayClient.shutdown();
});