import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "./types";

// localStorage keys used across the renderer.
export const LS = {
  serverUrl: "blm.serverUrl",
  token: "blm.token",
  username: "blm.username",
  employeeId: "blm.employeeId",
  role: "blm.role",
  agentId: "blm.agentId",
  trustMode: "blm.trustMode",
  autoRead: "blm.autoRead",
  // 后台完成通知（设置 → 常规；缺省 = 开）。
  notifyEnabled: "blm.notifyEnabled",
  // agent 读取文件时自动弹出阅读器（设置 → 常规；缺省 = 关）。
  viewerAutoOpen: "blm.viewerAutoOpen",
  // 代码高亮主题（highlight.js 官方模板名；见 viewer/codeTheme.ts）。
  codeTheme: "blm.codeTheme",
  // 界面主题（见 theme/uiTheme.ts；缺省 = 墨蓝深色）。
  uiTheme: "blm.uiTheme",
  // 阅读器文件树宽度（px，树右缘拖条；缺省 = 200）。
  vtreeWidth: "blm.vtreeWidth",
  avatarMode: "blm.avatarMode",
  voiceSettings: "blm.voiceSettings",
  // Pane widths dragged with the splitters (px).
  sidebarWidth: "blm.sidebarWidth",
  browserWidth: "blm.browserWidth",
  viewerWidth: "blm.viewerWidth",
  // Chat pane: input-bar height (px) and message font size (px, Shift+wheel).
  inputHeight: "blm.inputHeight",
  chatFontSize: "blm.chatFontSize",
  // Sidebar avatar zone dragged with the in-sidebar splitter (px);
  // absent = follow the CSS defaults (dragonfly 15% / digital human 24%).
  sidebarAvatarH: "blm.sidebarAvatarH",
  // Avatar zone collapsed upward ("1") or shown; absent = shown.
  sidebarAvatarCollapsed: "blm.sidebarAvatarCollapsed",
  // Same toggle as above, now owned by the store as「默认显示形象」("1"/"0").
  avatarVisible: "blm.avatarVisible",
  // 登录过的用户名（JSON 数组，最近优先；只记名字绝不记密码）。
  loginHistory: "blm.loginHistory",
} as const;

/** 登录历史（登录屏快捷选择）。坏数据一律当空。 */
export function loadLoginHistory(): string[] {
  try {
    const raw = localStorage.getItem(LS.loginHistory);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveLoginHistory(names: string[]): void {
  localStorage.setItem(LS.loginHistory, JSON.stringify(names.slice(0, 5)));
}

/** 登录成功后记名字：最近优先、去重、最多 5 个。 */
export function rememberLoginName(name: string): void {
  if (!name) return;
  saveLoginHistory([name, ...loadLoginHistory().filter((x) => x !== name)]);
}

/** 从登录历史移除（登录屏 ✕）。 */
export function forgetLoginName(name: string): void {
  saveLoginHistory(loadLoginHistory().filter((x) => x !== name));
}

/** 形象默认显隐。旧版只写 collapsed 键，首次读取时迁移过来。 */
export function loadAvatarVisible(): boolean {
  const v = localStorage.getItem(LS.avatarVisible);
  if (v !== null) return v === "1";
  const collapsed = localStorage.getItem(LS.sidebarAvatarCollapsed) === "1";
  localStorage.removeItem(LS.sidebarAvatarCollapsed);
  return !collapsed;
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(LS.voiceSettings);
    if (raw) {
      return { ...DEFAULT_VOICE_SETTINGS, ...(JSON.parse(raw) as Partial<VoiceSettings>) };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_VOICE_SETTINGS };
}

export function saveVoiceSettings(v: VoiceSettings): void {
  localStorage.setItem(LS.voiceSettings, JSON.stringify(v));
}

export function saveIdentity(
  serverUrl: string,
  token: string,
  username: string,
  employeeId: string,
  role: "admin" | "reviewer" | "user",
): void {
  localStorage.setItem(LS.serverUrl, serverUrl);
  localStorage.setItem(LS.token, token);
  localStorage.setItem(LS.username, username);
  localStorage.setItem(LS.employeeId, employeeId);
  localStorage.setItem(LS.role, role);
}

export function clearIdentity(): void {
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.username);
  localStorage.removeItem(LS.employeeId);
  localStorage.removeItem(LS.role);
}
