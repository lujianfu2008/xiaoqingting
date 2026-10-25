import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { LANGUAGES, menuStrings, resolveLanguage } from "./i18n";
import { loadSettings, patchSettings, type Language } from "./settings";

// Localized application menu (文件/编辑/视图/窗口/帮助/语言). Electron roles
// keep every accelerator and native behavior; only labels are overridden.

export function currentLanguage(): Language {
  return loadSettings().language;
}

export function applyAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu(currentLanguage()));
}

/** Menu item click → persist + rebuild + tell the renderer (in-app UI i18n). */
function setLanguage(lang: Language): void {
  patchSettings({ language: lang });
  applyAppMenu();
  const resolved = resolveLanguage(lang);
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("blm:menu:lang-changed", resolved);
  }
}

export function buildAppMenu(langSetting: Language): Menu {
  const t = menuStrings(langSetting);

  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        {
          label: t.settings,
          accelerator: "CmdOrCtrl+,",
          click: (_mi, win) => {
            // Electron types this as BaseWindow; only BrowserWindow has contents.
            (win as import("electron").BrowserWindow | undefined)?.webContents.send(
              "blm:menu:open-settings",
            );
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
      label: t.help,
      submenu: [{ role: "about", label: t.about }],
    },
    {
      label: t.language,
      submenu: LANGUAGES.map<MenuItemConstructorOptions>((l) => ({
        label: l.id === "system" ? t.langFollow : l.label,
        type: "radio",
        checked: langSetting === l.id,
        click: () => setLanguage(l.id),
      })),
    },
  ];

  return Menu.buildFromTemplate(template);
}
