import type {
  AdminUserDetail,
  AgentInfo,
  Block,
  LlmConfigInfo,
  ProjectMeta,
  SessionMeta,
  UpdateRequestView,
  UserSummary,
  WsPermissionRequest,
  WsToolExecRequest,
} from "@blm/protocol";
import type { DflyExpr } from "../components/DragonflyLogo";

export type WsStatus = "disconnected" | "connecting" | "connected";

export interface VoiceSettings {
  ttsVoice: string; // SAPI voice name, "" = default
  ttsRate: number; // -10..10
  ttsVolume: number; // 0..100
  asrAutoSend: boolean; // release-space: send directly vs fill the input box
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  ttsVoice: "",
  ttsRate: 0,
  ttsVolume: 100,
  asrAutoSend: true,
};

/** Minimal slice of zustand's api that the action factories need. */
export type SetState = (
  partial: Partial<BlmState> | ((s: BlmState) => Partial<BlmState>),
) => void;
export type GetState = () => BlmState;

export interface BlmState {
  serverUrl: string;
  token: string | null;
  username: string | null;
  employeeId: string | null; // display-only 工号, confirmed by the server
  role: "admin" | "user"; // 公有域管理员角色（服务端确认；bootstrap admin 恒为 admin）
  wsStatus: WsStatus;
  error: string | null;
  // Set when startup auto-login was blocked: the account is already signed in
  // in another instance on this machine. Holds the blocked 工号 for the notice.
  localLock: string | null;

  sessions: SessionMeta[];
  sharedSessions: SessionMeta[]; // read-only sessions shared by other users
  projects: ProjectMeta[]; // my project spaces + public projects, in creation order
  updateRequests: UpdateRequestView[]; // 公有域更新申请（管理员=全部，普通用户=自己的）
  presence: Record<string, boolean>; // username -> online, seeded via REST + WS deltas
  currentSessionId: string | null;
  sharedView: boolean; // true while viewing someone else's shared session
  agents: AgentInfo[];
  currentAgentId: string;
  blocksBySession: Record<string, Block[]>;
  streaming: Record<string, string>;
  busy: Record<string, boolean>;
  pendingPermission: WsPermissionRequest | null;
  pendingExec: WsToolExecRequest | null;
  trustMode: boolean;
  autoRead: boolean;
  voiceSettings: VoiceSettings;
  speaking: boolean; // TTS is currently reading aloud
  recording: boolean; // microphone is recording (voice input)
  expr: DflyExpr; // avatar expression driven by the latest reply's emotion tag
  avatarMode: "dragonfly" | "digitalhuman";
  llmConfig: LlmConfigInfo | null; // my per-user model settings (key never leaves server)
  browser: BrowserState; // built-in browser surface (embedded pane / popup)

  login(serverUrl: string, username: string, password: string): Promise<void>;
  register(
    serverUrl: string,
    employeeId: string,
    username: string,
    password: string,
  ): Promise<void>;
  loadMe(): Promise<void>;
  logout(): void;
  /** Startup gate: if the saved account is locked locally, drop the session
   *  state (memory only — storage is kept) and return the blocked 工号. */
  gateLocalLogin(): Promise<string | null>;
  connect(): void;
  newSession(agentId: string, projectId?: string | null): Promise<void>;
  loadSessions(): Promise<void>;
  loadProjects(): Promise<void>;
  createProject(input: {
    name: string;
    agentId: string;
    folder: "auto" | "choose";
    visibility?: "personal" | "public";
  }): Promise<ProjectMeta | null>;
  deleteProject(id: string): Promise<void>;
  loadUpdateRequests(): Promise<void>;
  /** 批准/拒绝一条公有域更新申请（仅管理员）。 */
  decideUpdateRequest(id: string, approve: boolean, reason?: string): Promise<boolean>;
  listAdminUsers(): Promise<AdminUserDetail[]>;
  setUserRole(username: string, role: "admin" | "user"): Promise<boolean>;
  setUserDisabled(username: string, disabled: boolean): Promise<boolean>;
  selectSession(id: string): Promise<void>;
  selectSharedSession(id: string): Promise<void>;
  setSessionShare(id: string, shared: boolean, sharedWith?: string[]): Promise<void>;
  listUsers(): Promise<UserSummary[]>;
  loadShared(): Promise<void>;
  ownerOnlineOf(sessionId: string): boolean;
  loadLlmConfig(): Promise<void>;
  saveLlmConfig(patch: { api_key?: string; base_url?: string; model?: string }): Promise<void>;
  clearLlmConfig(): Promise<void>;
  deleteSession(id: string): Promise<void>;
  moveSession(id: string, projectId: string | null): Promise<void>;
  setCurrentAgent(agentId: string): void;
  send(text: string): void;
  interrupt(): void;
  respondPermission(allow: boolean): void;
  respondExec(allow: boolean, trustFromNow: boolean): void;
  setTrustMode(on: boolean): void;
  setAutoRead(on: boolean): void;
  setRecording(on: boolean): void;
  speak(text: string, opts?: { voice?: string; rate?: number; volume?: number }): void;
  stopSpeaking(): void;
  setExpr(expr: DflyExpr, holdMs?: number): void;
  setAvatarMode(mode: "dragonfly" | "digitalhuman"): void;
  updateVoiceSettings(patch: Partial<VoiceSettings>): void;
  initBrowser(): void;
  setBrowserMode(mode: "embedded" | "popup"): Promise<void>;
  closeBrowser(): Promise<void>;
}

// Actions that never prompt again while trust mode is on (includes command
// execution, per user request — trust mode means fully autonomous operation).
export const TRUSTABLE_ACTIONS = new Set([
  "run_command",
  "read_file",
  "read_attachment",
  "write_file",
  "list_dir",
  "get_workdir",
  "choose_workdir",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_close",
]);
