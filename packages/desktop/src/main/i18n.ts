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
}

const STRINGS: Record<"zh-CN" | "en", MenuStrings> = {
  "zh-CN": {
    file: "文件",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    help: "帮助",
    language: "语言",
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
    resetZoom: "重置缩放",
    zoomIn: "放大",
    zoomOut: "缩小",
    fullscreen: "进入全屏",
    minimize: "最小化",
    close: "关闭",
    about: "关于 小蜻蜓",
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
  },
  en: {
    file: "File",
    edit: "Edit",
    view: "View",
    window: "Window",
    help: "Help",
    language: "Language",
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
    resetZoom: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    fullscreen: "Toggle Full Screen",
    minimize: "Minimize",
    close: "Close",
    about: "About Xiaoqingting",
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
