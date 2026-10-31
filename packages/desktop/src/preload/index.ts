import { contextBridge, ipcRenderer, webUtils } from "electron";

// Mirrors main/browser.ts BrowserState (preload must not import main modules).
interface BrowserState {
  mode: "embedded" | "popup";
  open: boolean;
  url: string;
  title: string;
}

// Mirrors main/executor/accessScope.ts accessScopeState().
interface AccessScopeState {
  workDir: string | null;
  /** Effective mode — for the requested project when one was passed. */
  mode: "workspace" | "full" | "custom";
  folders: string[];
  /** Present only when a project was queried: its override (null = 全局). */
  projectMode?: "workspace" | "full" | "custom" | null;
}

// The renderer is a pure UI client: it talks to the server over standard
// browser WebSocket/fetch APIs. Local actions (requested by the server) are
// executed in the main process through this IPC bridge.
contextBridge.exposeInMainWorld("blm", {
  platform: process.platform,
  versions: {
    app: process.env.npm_package_version ?? "0.1.0",
  },
  executeLocalAction: (request: {
    action: string;
    params: Record<string, unknown>;
    session_id?: string;
}): Promise<{ ok: boolean; output?: string; error?: string; images?: { media_type: string; data: string }[] }> =>
    ipcRenderer.invoke("blm:exec", request),
  bindProjectFolder: (
    projectId: string,
    opts: { name?: string; choose: boolean },
  ): Promise<{ ok: boolean; folder?: string; error?: string }> =>
    ipcRenderer.invoke("blm:projects:bind", { project_id: projectId, ...opts }),
  getProjectFolder: (projectId: string): Promise<{ folder: string | null }> =>
    ipcRenderer.invoke("blm:projects:getFolder", { project_id: projectId }),
  setSessionProject: (sessionId: string, projectId: string | null): Promise<void> =>
    ipcRenderer.invoke("blm:session:setProject", { session_id: sessionId, project_id: projectId }),
  forgetSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("blm:session:forget", { session_id: sessionId }),
  // Fired when 应用菜单 → 设置… is clicked in the main process.
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("blm:menu:open-settings", listener);
    return () => ipcRenderer.removeListener("blm:menu:open-settings", listener);
  },
  // Resolved UI language ("zh-CN" | "en"), for document.documentElement.lang.
  getLanguage: (): Promise<string> => ipcRenderer.invoke("blm:menu:getLanguage"),
  // In-app language switch: same persistence + broadcast as the native menu.
  setLanguage: (lang: "system" | "zh-CN" | "en"): Promise<string> =>
    ipcRenderer.invoke("blm:menu:setLanguage", lang),
  // Local single-login lock: is this account signed in elsewhere on this machine?
  checkLocalLogin: (userOrEid: string): Promise<{ locked: boolean }> =>
    ipcRenderer.invoke("blm:login:check", { user_or_eid: userOrEid }),
  acquireLocalLogin: (employeeId: string, username: string): Promise<void> =>
    ipcRenderer.invoke("blm:login:acquire", { employee_id: employeeId, username }),
  releaseLocalLogin: (): Promise<void> => ipcRenderer.invoke("blm:login:release"),
  // Fired when the language is switched in 应用菜单 → 语言.
  onLangChanged: (cb: (lang: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, lang: string): void => cb(lang);
    ipcRenderer.on("blm:menu:lang-changed", listener);
    return () => ipcRenderer.removeListener("blm:menu:lang-changed", listener);
  },
  // Attachments: resolve a dropped/picked File to its absolute on-disk path,
  // save clipboard bytes into the per-session store, get a chip thumbnail.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveAttachment: (
    sessionId: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke("blm:attachments:save", { session_id: sessionId, name, bytes }),
  previewAttachment: (path: string): Promise<{ dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke("blm:attachments:preview", { path }),
  markAttachments: (sessionId: string, paths: string[]): Promise<void> =>
    ipcRenderer.invoke("blm:attachments:mark", { session_id: sessionId, paths }),
  // 会话导出：渲染层拼好 Markdown，主进程弹原生保存框并写盘。
  exportChat: (
    req: { default_filename: string; markdown: string },
  ): Promise<{ saved: boolean; path: string | null; error?: string }> =>
    ipcRenderer.invoke("blm:chat:export", req),
  // Window-close behavior (✕ = quit or hide to tray).
  getPrefs: (): Promise<{ closeAction: "quit" | "tray" }> =>
    ipcRenderer.invoke("blm:app:getPrefs"),
  setCloseAction: (v: "quit" | "tray"): Promise<"quit" | "tray"> =>
    ipcRenderer.invoke("blm:app:setCloseAction", v),
  accessScope: {
    get: (projectId?: string): Promise<AccessScopeState> =>
      ipcRenderer.invoke("blm:access:get", { project_id: projectId }),
    setMode: (mode: AccessScopeState["mode"], projectId?: string): Promise<AccessScopeState> =>
      ipcRenderer.invoke("blm:access:setMode", { mode, project_id: projectId }),
    setProjectMode: (
      projectId: string,
      mode: AccessScopeState["mode"] | null,
    ): Promise<AccessScopeState> =>
      ipcRenderer.invoke("blm:access:setProjectMode", { project_id: projectId, mode }),
    addFolder: (): Promise<AccessScopeState & { folder: string | null }> =>
      ipcRenderer.invoke("blm:access:addFolder"),
    removeFolder: (folder: string): Promise<AccessScopeState> =>
      ipcRenderer.invoke("blm:access:removeFolder", { folder }),
  },
  speakText: (
    text: string,
    opts?: { voice?: string; rate?: number; volume?: number },
  ): Promise<{ audio?: Uint8Array; error?: string }> =>
    ipcRenderer.invoke("blm:tts:speak", { text, opts }),
  stopSpeaking: (): Promise<void> => ipcRenderer.invoke("blm:tts:stop"),
  listVoices: (): Promise<{ name: string; culture: string }[]> =>
    ipcRenderer.invoke("blm:tts:voices"),
  transcribeLocalPcm: (pcm: ArrayBuffer, pauses?: number[]): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke("blm:asr:transcribe", pcm, pauses),
  // 语音唤醒：词表/灵敏度 → 主进程（重）建 KeywordSpotter；音频块流式喂入；
  // 命中经 onWakeDetected 回调。focus 把窗口从托盘/最小化拉回前台。
  wakeConfigure: (
    words: string[],
    sensitivity: "low" | "medium" | "high",
  ): Promise<{ error?: string }> => ipcRenderer.invoke("blm:wake:configure", { words, sensitivity }),
  wakeChunk: (pcm: ArrayBuffer): void => ipcRenderer.send("blm:wake:chunk", pcm),
  wakeStop: (): void => ipcRenderer.send("blm:wake:stop"),
  onWakeDetected: (cb: (keyword: string) => void): (() => void) => {
    const listener = (_e: unknown, keyword: string): void => cb(keyword);
    ipcRenderer.on("blm:wake:detected", listener);
    return () => ipcRenderer.removeListener("blm:wake:detected", listener);
  },
  focusWindow: (): Promise<void> => ipcRenderer.invoke("blm:app:focus"),
  browser: {
    state: (): Promise<BrowserState> => ipcRenderer.invoke("blm:browser:state"),
    setBounds: (rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
      ipcRenderer.invoke("blm:browser:setBounds", rect),
    setMode: (mode: "embedded" | "popup"): Promise<BrowserState> =>
      ipcRenderer.invoke("blm:browser:setMode", mode),
    open: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("blm:browser:open", url),
    close: (): Promise<void> => ipcRenderer.invoke("blm:browser:close"),
    onState: (cb: (s: BrowserState) => void): (() => void) => {
      const listener = (_e: unknown, s: BrowserState): void => cb(s);
      ipcRenderer.on("blm:browser:state", listener);
      return () => ipcRenderer.removeListener("blm:browser:state", listener);
    },
  },
});
