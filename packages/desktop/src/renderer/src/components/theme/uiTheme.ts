// 界面主题：配色全部收敛在 styles/themes.css 的 CSS 变量上，
// 换主题 = 在 <html> 上设 data-ui-theme 属性（变量整体切换，
// 全文档即时生效，无 style 注入/无重排闪烁）。用户选择存
// localStorage（与代码高亮主题同模式，见 viewer/codeTheme.ts）；
// 主窗与阅读器弹窗各是独立文档，各自在启动时跑一次 initUiTheme()。
// 新增主题 = THEMES 加一行 + themes.css 加一段变量覆写
// （显示名走 i18n：gen.th.<id>，两份语言都要加）。

import { LS } from "../../store/persist";
import type { Key } from "../../i18n";

export interface UiThemeInfo {
  id: string;
  /** 设置下拉的显示名（i18n key）。 */
  labelKey: Key;
}

export const DEFAULT_UI_THEME = "midnight";

/** 精选主题：默认在前，其余按气质。 */
export const UI_THEMES: UiThemeInfo[] = [
  { id: "midnight", labelKey: "gen.th.midnight" },
  { id: "daylight", labelKey: "gen.th.daylight" },
  { id: "forest", labelKey: "gen.th.forest" },
  { id: "onyx", labelKey: "gen.th.onyx" },
  { id: "mist", labelKey: "gen.th.mist" },
  { id: "sakura", labelKey: "gen.th.sakura" },
];

/** 读用户选择；坏值（含历史遗留）回退默认。 */
export function loadUiTheme(): string {
  const id = localStorage.getItem(LS.uiTheme);
  return id && UI_THEMES.some((t) => t.id === id) ? id : DEFAULT_UI_THEME;
}

export function saveUiTheme(id: string): void {
  localStorage.setItem(LS.uiTheme, UI_THEMES.some((t) => t.id === id) ? id : DEFAULT_UI_THEME);
}

/** 在当前文档应用主题（幂等；弹窗窗口启动时也调一次）。 */
export function applyUiTheme(id: string): void {
  document.documentElement.dataset.uiTheme =
    UI_THEMES.some((t) => t.id === id) ? id : DEFAULT_UI_THEME;
}

/** 启动时恢复用户选择。 */
export function initUiTheme(): void {
  applyUiTheme(loadUiTheme());
}
