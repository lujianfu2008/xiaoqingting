import { create } from "zustand";
import type { AgentInfo } from "@blm/protocol";
import type { BlmState } from "./types";
import { LS, loadVoiceSettings } from "./persist";
import { apiBase } from "./http";
import { createAuthActions } from "./actions/auth";
import { createConnectionActions } from "./actions/connection";
import { createSessionActions } from "./actions/sessions";
import { createProjectActions } from "./actions/projects";
import { createAdminActions } from "./actions/admin";
import { createLlmActions } from "./actions/llm";
import { createChatActions } from "./actions/chat";
import { createVoiceActions } from "./actions/voice";
import { createBrowserActions } from "./actions/browser";

export type { BlmState, VoiceSettings, WsStatus } from "./types";

export const useStore = create<BlmState>((set, get) => ({
  serverUrl: localStorage.getItem(LS.serverUrl) ?? "",
  token: localStorage.getItem(LS.token),
  username: localStorage.getItem(LS.username),
  employeeId: localStorage.getItem(LS.employeeId),
  role: localStorage.getItem(LS.role) === "admin" ? "admin" : "user",
  wsStatus: "disconnected",
  error: null,
  localLock: null,

  sessions: [],
  sharedSessions: [],
  projects: [],
  updateRequests: [],
  presence: {},
  currentSessionId: null,
  sharedView: false,
  agents: [],
  currentAgentId: localStorage.getItem(LS.agentId) ?? "assistant",
  blocksBySession: {},
  streaming: {},
  busy: {},
  pendingPermission: null,
  pendingExec: null,
  trustMode: localStorage.getItem(LS.trustMode) === "1",
  autoRead: localStorage.getItem(LS.autoRead) === "1",
  speaking: false,
  recording: false,
  expr: "normal",
  avatarMode:
    localStorage.getItem(LS.avatarMode) === "digitalhuman" ? "digitalhuman" : "dragonfly",
  voiceSettings: loadVoiceSettings(),
  llmConfig: null,
  browser: { mode: "embedded", open: false, url: "", title: "" },

  ...createAuthActions(set, get),
  ...createConnectionActions(set, get),
  ...createSessionActions(set, get),
  ...createProjectActions(set, get),
  ...createAdminActions(set, get),
  ...createLlmActions(set, get),
  ...createChatActions(set, get),
  ...createVoiceActions(set, get),
  ...createBrowserActions(set, get),
}));

export function loadAgents(): Promise<void> {
  return new Promise((resolve) => {
    const { serverUrl, token } = useStore.getState();
    fetch(`${apiBase(serverUrl)}/api/agents`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((agents: AgentInfo[]) => {
        useStore.setState({ agents });
        resolve();
      })
      .catch(() => resolve());
  });
}
