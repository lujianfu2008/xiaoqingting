import { app } from "electron";
import type { Language } from "./settings";

// Menu-bar + main-process dialog/notification translations. The renderer keeps
// its own dictionary (renderer/src/i18n.ts) synced via "blm:menu:lang-changed".

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "system", label: "跟随系统 / Follow system" },
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
];

export interface MenuStrings {
  file: string;
  openFiles: string;
  edit: string;
  view: string;
  window: string;
  help: string;
  language: string;
  settings: string;
  quit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  reload: string;
  forceReload: string;
  devTools: string;
  resetZoom: string;
  zoomIn: string;
  zoomOut: string;
  fullscreen: string;
  minimize: string;
  close: string;
  about: string;
  checkUpdate: string;
  ok: string;
  langFollow: string;
  // native dialogs / tray / notifications
  workdirTitle: string;
  workdirButton: string;
  projectFolderTitle: string; // {name}
  projectFolderButton: string;
  accessFolderTitle: string;
  accessFolderButton: string;
  untitledProject: string;
  trayTip: string;
  trayOpen: string;
  trayQuit: string;
  trayNotifyBody: string;
  browserTitle: string;
  viewerTitle: string;
  updateTitle: string;
  updateFound: string; // {version}
  updateInstall: string;
  updateLater: string;
  updateUpToDate: string; // {version}
  updateDownloading: string; // {version}
  updateCheckFailed: string;
}

const STRINGS: Record<"zh-CN" | "en", MenuStrings> = {
  "zh-CN": {
    file: "文件",
    openFiles: "打开文件…",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    help: "帮助",
    language: "设置",
    settings: "设置…",
    quit: "退出",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    reload: "重新加载",
    forceReload: "强制重新加载",
    devTools: "开发者工具",
    resetZoom: "重置缩放（Ctrl+0）",
    zoomIn: "放大（Ctrl+=）",
    zoomOut: "缩小（Ctrl+-）",
    fullscreen: "进入全屏",
    minimize: "最小化",
    close: "关闭",
    about: "关于 小蜻蜓",
    checkUpdate: "检查更新",
    ok: "知道了",
    langFollow: "跟随系统",
    workdirTitle: "选择智能体的工作目录（文件操作和命令都在此目录下进行）",
    workdirButton: "设为工作目录",
    projectFolderTitle: "为项目「{name}」选择文件夹（文件操作和命令都在此目录下进行）",
    projectFolderButton: "绑定此文件夹",
    accessFolderTitle: "选择允许读取的文件夹（写入/删除仍仅限工作目录）",
    accessFolderButton: "允许读取此文件夹",
    untitledProject: "未命名项目",
    trayTip: "小蜻蜓",
    trayOpen: "打开小蜻蜓",
    trayQuit: "退出",
    trayNotifyBody: "已最小化到系统托盘，点击托盘图标恢复；菜单「文件 → 退出」真正退出。",
    browserTitle: "内置浏览器",
    viewerTitle: "文件阅读器",
    updateTitle: "发现新版本",
    updateFound: "新版本 {version} 已下载完成，是否立即重启安装？",
    updateInstall: "立即安装",
    updateLater: "下次启动时",
    updateUpToDate: "当前已是最新版本（v{version}）。",
    updateDownloading: "发现新版本 {version}，正在后台下载，完成后会提示安装。",
    updateCheckFailed: "检查更新失败：可能是网络不通或更新源暂时不可达，请稍后再试。",
  },
  en: {
    file: "File",
    openFiles: "Open Files…",
    edit: "Edit",
    view: "View",
    window: "Window",
    help: "Help",
    language: "Settings",
    settings: "Settings…",
    quit: "Quit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    reload: "Reload",
    forceReload: "Force Reload",
    devTools: "Toggle Developer Tools",
    resetZoom: "Actual Size (Ctrl+0)",
    zoomIn: "Zoom In (Ctrl+=)",
    zoomOut: "Zoom Out (Ctrl+-)",
    fullscreen: "Toggle Full Screen",
    minimize: "Minimize",
    close: "Close",
    about: "About Xiaoqingting",
    checkUpdate: "Check for Updates",
    ok: "OK",
    langFollow: "Follow system",
    workdirTitle: "Choose the agent's work dir (file operations and commands run inside it)",
    workdirButton: "Set as work dir",
    projectFolderTitle: "Choose a folder for the project “{name}” (file operations and commands run inside it)",
    projectFolderButton: "Bind this folder",
    accessFolderTitle: "Choose a folder that may be read (writes/deletes stay workdir-only)",
    accessFolderButton: "Allow reading this folder",
    untitledProject: "Untitled project",
    trayTip: "Xiaoqingting",
    trayOpen: "Open Xiaoqingting",
    trayQuit: "Quit",
    trayNotifyBody: "Minimized to the system tray — click the tray icon to restore; File → Quit exits for real.",
    browserTitle: "Browser",
    viewerTitle: "File viewer",
    updateTitle: "Update available",
    updateFound: "Version {version} has been downloaded. Restart and install now?",
    updateInstall: "Install now",
    updateLater: "On next launch",
    updateUpToDate: "You're on the latest version (v{version}).",
    updateDownloading: "Version {version} found — downloading in the background; you'll be prompted when it's ready.",
    updateCheckFailed: "Update check failed — the network or the update source may be unreachable. Try again later.",
  },
} as const;

function interpolate(s: string, vars?: Record<string, string>): string {
  if (!vars) return s;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Strings for native dialogs / tray / notifications in the resolved language. */
export function uiStrings(langSetting: Language, vars?: Record<string, string>): MenuStrings {
  return interpolateRecord(STRINGS[resolveLanguage(langSetting)], vars);
}

function interpolateRecord(rec: MenuStrings, vars?: Record<string, string>): MenuStrings {
  if (!vars) return rec;
  const out = { ...rec };
  for (const k of Object.keys(out) as (keyof MenuStrings)[]) {
    out[k] = interpolate(out[k], vars);
  }
  return out;
}

export function menuStrings(lang: Language): MenuStrings {
  return STRINGS[resolveLanguage(lang)];
}

/** "system" resolves through the OS locale; zh* → zh-CN, everything else en. */
export function resolveLanguage(lang: Language): "zh-CN" | "en" {
  if (lang !== "system") return lang;
  return app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
