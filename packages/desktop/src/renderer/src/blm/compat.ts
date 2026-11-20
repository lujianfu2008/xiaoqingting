// blmCompat：Android WebView 壳下的 window.blm 同签名实现。
// 桌面端 preload 已经注入 window.blm，install.ts 会提前 return，
// 本文件整段不会执行 —— 调用点因此不需要任何守卫。
//
// 能力对齐原则：每个成员要么真实现，要么给「良性 stub」
// （返回类型正确的空值/成功值），绝不让业务链路 TypeError。
// 真实现随壳侧能力模块逐里程碑补齐（Core → 语音 → 文件 → …）。

import { ModelState } from "@blm/protocol";
import {
  call,
  probeBridgeInfo,
  subscribeEvent,
  blobPut,
} from "./transport";

type ExecResult = {
  ok: boolean;
  output?: string;
  error?: string;
  images?: { media_type: string; data: string }[];
};

interface BrowserStateCompat {
  mode: "embedded" | "popup";
  open: boolean;
  url: string;
  title: string;
  session_id: string;
}

const LANG_KEY = "blm.lang";

const uiLang = (): "zh-CN" | "en" =>
  (localStorage.getItem(LANG_KEY) ||
    (navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en")) as
    | "zh-CN"
    | "en";

// ---------- 事件订阅退化缓存：壳未加载完成时的事件不丢 ----------
const earlyEvents: Record<string, unknown[]> = {};
const hasSub = new Set<string>();
function emitBuffered(name: string): void {
  const buf = earlyEvents[name];
  if (!buf?.length) return;
  for (const p of buf.splice(0)) {
    window.__blmEvent?.(name, JSON.stringify(p));
  }
}

function subEvent<T>(name: string, cb: (p: T) => void): () => void {
  if (!hasSub.has(name)) {
    hasSub.add(name);
    emitBuffered(name);
  }
  return subscribeEvent(name, (p) => cb(p as T));
}

// ---------- 能力模块（壳侧按 method 路由） ----------

// M1：本机执行一律拒绝回执（引擎得到明确错误而非超时；
// 桌面在线时由桌面接单 —— 服务端 kind=mobile 只把执行请求
// 优先派给桌面）。文案对齐桌面「移动端暂不支持」语气。
function rejectLocalAction(action: string): ExecResult {
  return {
    ok: false,
    error: `移动端暂不支持本机执行「${action}」，请在桌面端在线时使用。`,
  };
}

// 语音/更新/模型等后续里程碑的能力：M1 统一报「即将支持」。
function notYet(kind: string): { error: string } {
  return { error: `${kind} 功能即将在 Android 端支持` };
}
// 各协议形状的「即将支持」错误体（对齐 @blm/protocol 结果 union）。
function viewerError(kind: string): { kind: "error"; error: string } {
  return { kind: "error", error: `${kind} 功能即将在 Android 端支持` };
}

const modelsState: ModelState[] = [
  { name: "sherpa-paraformer", ready: false, phase: "idle", percent: 0 },
  { name: "sherpa-kws", ready: false, phase: "idle", percent: 0 },
];

const emptyBrowser = (): BrowserStateCompat => ({
  mode: "embedded",
  open: false,
  url: "",
  title: "",
  session_id: "",
});

export function createBlmCompat(): typeof window.blm {
  const info = probeBridgeInfo();
  const appVersion = info?.app_version ?? "0.0.0-android";
  type Blm = typeof window.blm;
  type Ev = Parameters<Parameters<Blm["onNotifyActivate"]>[0]>;

  const compat: Blm = {
    platform: "android",
    versions: { app: appVersion },

    executeLocalAction: (request: Parameters<Blm["executeLocalAction"]>[0]) =>
      Promise.resolve(rejectLocalAction(request.action)),

    bindProjectFolder: (
      _projectId: string,
      _opts: { name?: string; choose: boolean },
    ) => Promise.resolve({ ok: false, error: "项目目录绑定即将支持" }),
    getProjectFolder: () => Promise.resolve({ folder: null }),
    setSessionProject: () => Promise.resolve(),
    forgetSession: () => Promise.resolve(),

    onOpenSettings: () => () => undefined,
    onOpenFiles: () => () => undefined,
    // 无原生菜单/快捷键来源，缩放只走页面内手势（未来壳侧
    // 提供时经这里接）。滚轮监听在 renderer，无需壳配合。
    onViewerZoom: () => () => undefined,

    getLanguage: () => Promise.resolve(uiLang()),
    setLanguage: (lang: Parameters<Blm["setLanguage"]>[0]) => {
      const v = lang === "system" ? uiLang() : lang;
      localStorage.setItem(LANG_KEY, v);
      window.__blmEvent!("langChanged", JSON.stringify(v));
      return Promise.resolve(v);
    },
    onLangChanged: (cb) =>
      subEvent<string>("langChanged", (v) => cb(v ?? "zh-CN")),

    // Android 单实例：无本机多开锁语义。
    checkLocalLogin: () => Promise.resolve({ locked: false }),
    acquireLocalLogin: () => Promise.resolve(),
    releaseLocalLogin: () => Promise.resolve(),

    getPrefs: () =>
      Promise.resolve({ closeAction: "quit" as const }),
    setCloseAction: (v) => Promise.resolve(v),

    diagScreenshot: () => Promise.resolve(null),
    diagBrowserBounds: () =>
      Promise.resolve({ x: 0, y: 0, width: 0, height: 0 }),
    diagScreenInfo: () =>
      Promise.resolve({
        bounds: { x: 0, y: 0, width: screen.width, height: screen.height },
        workArea: { x: 0, y: 0, width: screen.width, height: screen.height },
        scaleFactor: window.devicePixelRatio || 1,
        contentSize: { width: window.innerWidth, height: window.innerHeight },
      }),
    diagAppVersion: () => Promise.resolve(appVersion),

    accessScope: {
      // 移动端暂无桌面目录概念：full（不设限）+ 无自定义目录。
      get: (_projectId?: string) =>
        Promise.resolve({
          workDir: null,
          mode: "full" as const,
          folders: [],
          projectMode: null,
        }),
      setMode: (mode: "workspace" | "full" | "custom") =>
        Promise.resolve({
          workDir: null,
          mode,
          folders: [],
          projectMode: null,
        }),
      setProjectMode: (_projectId: string, mode: "workspace" | "full" | "custom" | null) =>
        Promise.resolve({
          workDir: null,
          mode: "full" as const,
          folders: [],
          projectMode: mode,
        }),
      addFolder: () =>
        Promise.resolve({
          workDir: null,
          mode: "full" as const,
          folders: [],
          projectMode: null,
          folder: null,
        }),
      removeFolder: (_folder: string) =>
        Promise.resolve({
          workDir: null,
          mode: "full" as const,
          folders: [],
          projectMode: null,
        }),
    },

    speakText: () =>
      Promise.resolve(notYet("语音合成")),
    stopSpeaking: () => Promise.resolve(),
    listVoices: () => Promise.resolve([]),
    transcribeLocalPcm: (pcm: ArrayBuffer) => {
      const bytes = new Uint8Array(pcm.slice(0));
      return blobPut(bytes).then(
        (id) =>
          call<{ text?: string; error?: string }>("asr.transcribe", {
            blob: id,
          }).then((r) => ({ text: r.text ?? "", error: r.error })),
      );
    },

    wakeConfigure: () => Promise.resolve(notYet("语音唤醒")),
    wakeChunk: () => undefined,
    wakeStop: () => undefined,
    onWakeDetected: () => () => undefined,

    focusWindow: () => call<void>("app.focus"),

    notify: (args: { title: string; body?: string; session_id?: string }) =>
      call<void>("notify.show", {
        title: args.title,
        body: args.body ?? "",
        session_id: args.session_id ?? null,
      }),
    onNotifyActivate: (cb) =>
      subEvent<string | null>("notifyActivate", (sid) => cb(sid ?? null)),

    bindUpdater: () => Promise.resolve(),
    checkUpdate: () => Promise.resolve("up_to_date"),
    cancelUpdate: () => undefined,
    onUpdateProgress: () => () => undefined,

    bindModelSource: () => Promise.resolve(),
    modelsState: () => Promise.resolve(modelsState.map((m) => ({ ...m }))),
    downloadModel: (name: "sherpa-paraformer" | "sherpa-kws") =>
      Promise.resolve({
        name,
        ready: false,
        phase: "error" as const,
        percent: 0,
        error: "模型下载即将支持",
      } satisfies ModelState),
    onModelState: () => () => undefined,

    relayConfigure: () =>
      Promise.resolve({ ok: false, ...notYet("网络中继") }),
    relayStatus: () =>
      Promise.resolve({
        enabled: false,
        connected: false,
        active_requests: 0,
        requests_total: 0,
        requests_failed: 0,
      }),

    // 附件：pathForFile 恒空串 → ChatPane 自动走 saveAttachment
    // 字节兜底分支（移动端没有本机路径概念）。
    pathForFile: () => "",
    saveAttachment: (sessionId: string, name: string, bytes: Uint8Array) =>
      blobPut(bytes).then((blob) =>
        call<{ path?: string; error?: string }>("attachments.save", {
          session_id: sessionId,
          name,
          blob,
        }),
      ),
    previewAttachment: (path: string) =>
      call<{ dataUrl?: string; error?: string }>("attachments.preview", { path }),
    markAttachments: (sessionId: string, paths: string[]) =>
      call<void>("attachments.mark", { session_id: sessionId, paths }),

    exportChat: (req: { default_filename: string; markdown: string }) =>
      call<{ saved: boolean; path: string | null; error?: string }>(
        "chat.export",
        req,
      ),

    viewer: {
      stat: () => Promise.resolve(viewerError("文件阅读器")),
      listDir: () =>
        Promise.resolve({
          entries: [],
          has_more: false,
          ...notYet("文件阅读器"),
        }),
      read: () => Promise.resolve(viewerError("文件阅读器")),
      openDialog: () => Promise.resolve({ paths: [] }),
      popOut: () => Promise.resolve(notYet("文件阅读器")),
      openExternal: () => Promise.resolve(notYet("外部打开")),
    },

    browser: {
      state: () => Promise.resolve(emptyBrowser()),
      setActiveSession: () => Promise.resolve(),
      setBounds: () => Promise.resolve(),
      setViewport: () => Promise.resolve(),
      setMode: () => Promise.resolve(emptyBrowser()),
      open: () =>
        Promise.resolve({ ok: false, ...notYet("内置浏览器") }),
      close: () => Promise.resolve(),
      onState: () => () => undefined,
    },
  };
  return compat;
}
