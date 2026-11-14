// 代码高亮主题：配色不写死在代码里——用 highlight.js 官方
// 主题 CSS 模板（highlight.js/styles/*.css，随包分发的社区
// 标准配色，exports "./styles/*" 暴露）。这里只存
// 「主题名 → 懒加载模板」映射 + 用户选择（localStorage）；
// 注入是全文档唯一的 <style data-hljs-theme>，换主题 = 替换
// 内容，旧主题不留痕（动态 import CSS 会永久插 <style>，
// 多个主题会叠着打架，所以走 raw 文本自管）。
// 新增主题 = THEME_CSS 加一行 import，设置下拉自动出现。

export interface CodeThemeInfo {
  id: string;
  /** 设置下拉的显示名（主题名是专有名词，不做翻译）。 */
  label: string;
}

export const DEFAULT_CODE_THEME = "github-dark";

/** 精选官方主题：暗色在前（产品默认取向），其余按知名度。 */
export const CODE_THEMES: CodeThemeInfo[] = [
  { id: "github-dark", label: "GitHub Dark" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed" },
  { id: "atom-one-dark", label: "Atom One Dark" },
  { id: "nord", label: "Nord" },
  { id: "monokai", label: "Monokai" },
  { id: "tokyo-night-dark", label: "Tokyo Night Dark" },
  { id: "night-owl", label: "Night Owl" },
  { id: "shades-of-purple", label: "Shades of Purple" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon" },
  { id: "tomorrow-night-blue", label: "Tomorrow Night Blue" },
  { id: "stackoverflow-dark", label: "StackOverflow Dark" },
  { id: "a11y-dark", label: "A11y Dark" },
  { id: "vs2015", label: "Visual Studio Dark" },
  { id: "github", label: "GitHub" },
  { id: "atom-one-light", label: "Atom One Light" },
  { id: "tokyo-night-light", label: "Tokyo Night Light" },
  { id: "stackoverflow-light", label: "StackOverflow Light" },
  { id: "a11y-light", label: "A11y Light" },
  { id: "intellij-light", label: "IntelliJ Light" },
  { id: "xcode", label: "Xcode" },
];

/** 主题模板懒加载表（?raw 取 CSS 文本，自带 Vite 分包）。 */
const THEME_CSS: Record<string, () => Promise<{ default: string }>> = {
  "github-dark": () => import("highlight.js/styles/github-dark.css?raw"),
  "github-dark-dimmed": () => import("highlight.js/styles/github-dark-dimmed.css?raw"),
  "atom-one-dark": () => import("highlight.js/styles/atom-one-dark.css?raw"),
  "nord": () => import("highlight.js/styles/nord.css?raw"),
  "monokai": () => import("highlight.js/styles/monokai.css?raw"),
  "tokyo-night-dark": () => import("highlight.js/styles/tokyo-night-dark.css?raw"),
  "night-owl": () => import("highlight.js/styles/night-owl.css?raw"),
  "shades-of-purple": () => import("highlight.js/styles/shades-of-purple.css?raw"),
  "rose-pine-moon": () => import("highlight.js/styles/rose-pine-moon.css?raw"),
  "tomorrow-night-blue": () => import("highlight.js/styles/tomorrow-night-blue.css?raw"),
  "stackoverflow-dark": () => import("highlight.js/styles/stackoverflow-dark.css?raw"),
  "a11y-dark": () => import("highlight.js/styles/a11y-dark.css?raw"),
  "vs2015": () => import("highlight.js/styles/vs2015.css?raw"),
  "github": () => import("highlight.js/styles/github.css?raw"),
  "atom-one-light": () => import("highlight.js/styles/atom-one-light.css?raw"),
  "tokyo-night-light": () => import("highlight.js/styles/tokyo-night-light.css?raw"),
  "stackoverflow-light": () => import("highlight.js/styles/stackoverflow-light.css?raw"),
  "a11y-light": () => import("highlight.js/styles/a11y-light.css?raw"),
  "intellij-light": () => import("highlight.js/styles/intellij-light.css?raw"),
  "xcode": () => import("highlight.js/styles/xcode.css?raw"),
};

import { LS } from "../../store/persist";

const LS_KEY = LS.codeTheme;

/** 读用户选择；坏值（含历史遗留）回退默认。 */
export function loadCodeTheme(): string {
  const id = localStorage.getItem(LS_KEY);
  return id && THEME_CSS[id] ? id : DEFAULT_CODE_THEME;
}

export function saveCodeTheme(id: string): void {
  localStorage.setItem(LS_KEY, THEME_CSS[id] ? id : DEFAULT_CODE_THEME);
}

/** 连续切主题时按请求序落款：只有最新一次请求能写 style。 */
let applySeq = 0;

/**
 * 应用主题到当前文档（幂等；换主题 = 替换 style 内容）。
 * 主窗/弹窗各是独立文档，各自调一次即可。
 */
export async function applyCodeTheme(id: string): Promise<void> {
  const mine = ++applySeq;
  const load = THEME_CSS[id] ?? THEME_CSS[DEFAULT_CODE_THEME];
  const { default: css } = await load();
  if (mine !== applySeq) return; // 更晚的切换已发起，这版作废
  let el = document.head.querySelector<HTMLStyleElement>("style[data-hljs-theme]");
  if (!el) {
    el = document.createElement("style");
    el.dataset.hljsTheme = "";
    document.head.appendChild(el);
  }
  el.textContent = css;
}
