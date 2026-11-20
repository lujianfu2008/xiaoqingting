import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { LANGUAGES, menuStrings, resolveLanguage } from "./i18n";
import { loadSettings, patchSettings, type Language } from "./settings";
import { safeSend, windowAlive } from "./safeSend";
import { wireViewerZoom } from "./zoom";

// Localized application menu (文件/编辑/视图/窗口/设置/帮助). Electron
// roles keep every accelerator and native behavior; only labels are overridden.
// 设置入口在「设置」菜单顶部（语言选择的同一菜单），经 IPC 打开渲染端的设置对话框。

export function currentLanguage(): Language {
  return loadSettings().language;
}

export function applyAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu(currentLanguage()));
}

/** Menu item click / in-app settings → persist + rebuild + tell the renderer. */
export function setLanguage(lang: Language): void {
  patchSettings({ language: lang });
  applyAppMenu();
  const resolved = resolveLanguage(lang);
  for (const w of BrowserWindow.getAllWindows()) {
    if (windowAlive(w)) safeSend(w.webContents, "blm:menu:lang-changed", resolved);
  }
}

// 阅读器缩放快捷键（Ctrl+= / Ctrl+- / Ctrl+0）：壳窗口拦截
// 后发给自己的 renderer（viewer 组件订阅 blm:viewer:zoom
// 应用到内容上）。不用菜单 accelerator：accelerator 全局生效，
// 会把按键从聚焦的内置浏览器页面手里抢走（那里同键是页面
// 缩放，键表在 zoom.ts）；before-input-event 的 preventDefault
// 同样压掉菜单快捷键，两边各管各的聚焦面。缩放壳本身是
// 禁止的（createWindow 把 zoomFactor 钉死 1——UI 缩放防漂移）。
export const wireShellZoom = wireViewerZoom;

/** 视图菜单的缩放项（无 accelerator，键走 wireShellZoom）。 */
function sendViewerZoom(
  win: Electron.BaseWindow | undefined,
  cmd: "in" | "out" | "reset",
): void {
  // Electron types this as BaseWindow; only BrowserWindow has contents.
  const w = win as BrowserWindow | undefined;
  if (windowAlive(w)) safeSend(w.webContents, "blm:viewer:zoom", cmd);
}

export function buildAppMenu(langSetting: Language): Menu {
  const t = menuStrings(langSetting);

  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        {
          label: t.openFiles,
          click: (_mi, win) => {
            // Electron types this as BaseWindow; only BrowserWindow has contents.
            const w = win as import("electron").BrowserWindow | undefined;
            if (windowAlive(w)) safeSend(w.webContents, "blm:menu:open-files");
          },
        },
        { type: "separator" },
        { role: "quit", label: t.quit },
      ],
    },
    {
      label: t.edit,
      submenu: [
        { role: "undo", label: t.undo },
        { role: "redo", label: t.redo },
        { type: "separator" },
        { role: "cut", label: t.cut },
        { role: "copy", label: t.copy },
        { role: "paste", label: t.paste },
        { role: "selectAll", label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { role: "reload", label: t.reload },
        { role: "forceReload", label: t.forceReload },
        { role: "toggleDevTools", label: t.devTools },
        { type: "separator" },
        // 缩放是阅读器内容的缩放（见 wireShellZoom）——role
        // 的目标（壳窗口）被钉死 zoomFactor=1，role 是死键。
        {
          label: t.zoomIn,
          click: (mi, win) => sendViewerZoom(win, "in"),
        },
        {
          label: t.zoomOut,
          click: (mi, win) => sendViewerZoom(win, "out"),
        },
        {
          label: t.resetZoom,
          click: (mi, win) => sendViewerZoom(win, "reset"),
        },
        { type: "separator" },
        { role: "togglefullscreen", label: t.fullscreen },
      ],
    },
    {
      label: t.window,
      submenu: [
        { role: "minimize", label: t.minimize },
        { role: "close", label: t.close },
      ],
    },
    {
      label: t.language,
      submenu: [
        {
          label: t.settings,
          accelerator: "CmdOrCtrl+,",
          click: (_mi, win) => {
            // Electron types this as BaseWindow; only BrowserWindow has contents.
            const w = win as import("electron").BrowserWindow | undefined;
            if (windowAlive(w)) safeSend(w.webContents, "blm:menu:open-settings");
          },
        },
        { type: "separator" },
        ...LANGUAGES.map<MenuItemConstructorOptions>((l) => ({
          label: l.id === "system" ? t.langFollow : l.label,
          type: "radio",
          checked: langSetting === l.id,
          click: () => setLanguage(l.id),
        })),
      ],
    },
    {
      label: t.help,
      submenu: [{ role: "about", label: t.about }],
    },
  ];

  return Menu.buildFromTemplate(template);
}
