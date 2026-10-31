import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { LANGUAGES, menuStrings, resolveLanguage } from "./i18n";
import { loadSettings, patchSettings, type Language } from "./settings";
import { safeSend, windowAlive } from "./safeSend";

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

export function buildAppMenu(langSetting: Language): Menu {
  const t = menuStrings(langSetting);

  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [{ role: "quit", label: t.quit }],
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
        { role: "resetZoom", label: t.resetZoom },
        { role: "zoomIn", label: t.zoomIn },
        { role: "zoomOut", label: t.zoomOut },
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
