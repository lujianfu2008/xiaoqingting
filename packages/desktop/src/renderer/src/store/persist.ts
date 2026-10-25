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
  avatarMode: "blm.avatarMode",
  voiceSettings: "blm.voiceSettings",
  // Pane widths dragged with the splitters (px).
  sidebarWidth: "blm.sidebarWidth",
  browserWidth: "blm.browserWidth",
  // Chat pane: input-bar height (px) and message font size (px, Shift+wheel).
  inputHeight: "blm.inputHeight",
  chatFontSize: "blm.chatFontSize",
} as const;

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
  role: "admin" | "user",
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
