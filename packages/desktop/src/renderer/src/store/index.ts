import { create } from "zustand";
import type { AgentInfo } from "@blm/protocol";
import type { BlmState } from "./types";
import { LS, loadAvatarVisible, loadVoiceSettings } from "./persist";
import { apiBase } from "./http";
import { createAuthActions } from "./actions/auth";
import { createConnectionActions } from "./actions/connection";
import { createSessionActions } from "./actions/sessions";
import { createTaskActions } from "./actions/tasks";
import { createProjectActions } from "./actions/projects";
import { createAdminActions } from "./actions/admin";
import { createLlmActions } from "./actions/llm";
import { createRelayActions } from "./actions/relay";
import { createMcpActions } from "./actions/mcp";
import { createSkillActions } from "./actions/skills";
import { createWorkflowActions } from "./actions/workflows";
import { createScheduleActions } from "./actions/schedules";
import { createChatActions } from "./actions/chat";
import { createVoiceActions } from "./actions/voice";
import { createBrowserActions } from "./actions/browser";
import { createViewerActions } from "./actions/viewer";

export type { BlmState, ViewerState, ViewerTab, VoiceSettings, WsStatus } from "./types";

const storedRole = localStorage.getItem(LS.role);

export const useStore = create<BlmState>((set, get) => ({
  serverUrl: localStorage.getItem(LS.serverUrl) ?? "",
  token: localStorage.getItem(LS.token),
  username: localStorage.getItem(LS.username),
  employeeId: localStorage.getItem(LS.employeeId),
  role: storedRole === "admin" || storedRole === "reviewer" ? storedRole : "user",
  wsStatus: "disconnected",
  error: null,
  notice: null,
  localLock: null,
  registeredPending: null,
  authNotice: null,
  wakeError: null,

  sessions: [],
  sharedSessions: [],
  projects: [],
  updateRequests: [],
  tasks: [],
  schedules: [],
  auditLog: [],
  pendingReviewCount: 0,
  presence: {},
  currentSessionId: null,
  sharedView: false,
  openTabs: [],
  agents: [],
  currentAgentId: localStorage.getItem(LS.agentId) ?? "assistant",
  attachments: {},
  blocksBySession: {},
  streaming: {},
  busy: {},
  draftsBySession: {},
  usageBySession: {},
  pendingPermission: [],
  pendingExec: [],
  trustMode: localStorage.getItem(LS.trustMode) === "1",
  autoRead: localStorage.getItem(LS.autoRead) === "1",
  notifyEnabled: localStorage.getItem(LS.notifyEnabled) !== "0",
  speaking: false,
  recording: false,
  recWake: false,
  continuousVoice: false,
  expr: "normal",
  avatarMode:
    localStorage.getItem(LS.avatarMode) === "digitalhuman" ? "digitalhuman" : "dragonfly",
  avatarVisible: loadAvatarVisible(),
  voiceSettings: loadVoiceSettings(),
  llmConfig: null,
  mcpServers: null,
  globalMcpServers: null,
  skills: null,
  globalSkills: null,
  workflows: null,
  globalWorkflows: null,
  myRelay: null,
  adminRelayConfig: null,
  browser: { mode: "embedded", open: false, url: "", title: "", session_id: "" },
  viewer: { open: false, tabs: [], activeId: null, treeRoot: null, treeCollapsed: false },
  viewerAutoOpen: localStorage.getItem(LS.viewerAutoOpen) === "1",

  ...createAuthActions(set, get),
  ...createConnectionActions(set, get),
  ...createSessionActions(set, get),
  ...createTaskActions(set, get),
  ...createProjectActions(set, get),
  ...createAdminActions(set, get),
  ...createLlmActions(set, get),
  ...createRelayActions(set, get),
  ...createMcpActions(set, get),
  ...createSkillActions(set, get),
  ...createWorkflowActions(set, get),
  ...createScheduleActions(set, get),
  ...createChatActions(set, get),
  ...createVoiceActions(set, get),
  ...createBrowserActions(set, get),
  ...createViewerActions(set, get),
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
