import type {
  AdminUserDetail,
  AgentInfo,
  AuditEntry,
  Block,
  ImportMcpResult,
  ImportSkillsResult,
  LlmConfigInfo,
  McpRegistrySearchResponse,
  McpServerDef,
  MyRelayStatus,
  RelayConfigInfo,
  RelayConfigUpdate,
  SkillRegistrySearchResponse,
  McpServerInfo,
  ProjectMeta,
  SkillInfo,
  SessionMeta,
  UpdateRequestView,
  Usage,
  UserSummary,
  UpdateLlmConfigRequest,
  WsPermissionRequest,
  WsToolExecRequest,
} from "@blm/protocol";
import type { DflyExpr } from "../components/DragonflyLogo";

export type WsStatus = "disconnected" | "connecting" | "connected";

export type WakeSensitivity = "low" | "medium" | "high";

export interface VoiceSettings {
  ttsVoice: string; // SAPI voice name, "" = default
  ttsRate: number; // -10..10
  ttsVolume: number; // 0..100
  asrAutoSend: boolean; // release-space: send directly vs fill the input box
  wakeEnabled: boolean; // 语音唤醒总开关
  wakeWords: string; // 逗号分隔的唤醒词（同音叫法自动兼容）
  wakeSensitivity: WakeSensitivity; // 越低越少误触，越高越容易唤醒
  wakeContinuous: boolean; // 唤醒后进入连续对话（免唤醒词连说）
  wakeContinuousSecs: number; // 连续对话静默多少秒后退出（30/60/120）
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  ttsVoice: "",
  ttsRate: 0,
  ttsVolume: 100,
  asrAutoSend: true,
  wakeEnabled: false,
  wakeWords: "小蜻蜓,小蜻,小青",
  wakeSensitivity: "medium",
  wakeContinuous: false,
  wakeContinuousSecs: 60,
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
  role: "admin" | "reviewer" | "user"; // 公有域角色（服务端确认；bootstrap admin 恒为 admin）
  wsStatus: WsStatus;
  error: string | null;
  // Set when startup auto-login was blocked: the account is already signed in
  // in another instance on this machine. Holds the blocked 工号 for the notice.
  localLock: string | null;
  // 注册成功但待审核：登录屏显示等待审核页（审核通过后才能登录）。
  registeredPending: string | null;
  // 登录屏提示（如服务端强制登出：账号被禁用/未过审）。
  authNotice: string | null;
  // 语音唤醒初始化/麦克风失败提示（设置面板展示；成功配置时为 null）。
  wakeError: string | null;

  sessions: SessionMeta[];
  sharedSessions: SessionMeta[]; // read-only sessions shared by other users
  projects: ProjectMeta[]; // my project spaces + public projects, in creation order
  updateRequests: UpdateRequestView[]; // 公有域更新申请（管理员=全部，普通用户=自己的）
  auditLog: AuditEntry[]; // 管理动作审计（最近在前，仅管理页拉取）
  pendingReviewCount: number; // 待审核注册数（WS 实时推送 + 上线补推，审核员/管理员可见）
  presence: Record<string, boolean>; // username -> online, seeded via REST + WS deltas
  currentSessionId: string | null;
  sharedView: boolean; // true while viewing someone else's shared session
  agents: AgentInfo[];
  currentAgentId: string;
  blocksBySession: Record<string, Block[]>;
  streaming: Record<string, string>;
  busy: Record<string, boolean>;
  usageBySession: Record<string, Usage>; // 最近一次回复的 token 用量（result 推送）
  pendingPermission: WsPermissionRequest | null;
  pendingExec: WsToolExecRequest | null;
  trustMode: boolean;
  autoRead: boolean;
  voiceSettings: VoiceSettings;
  speaking: boolean; // TTS is currently reading aloud
  recording: boolean; // microphone is recording (voice input)
  recWake: boolean; // 本次录音由语音唤醒触发（横幅文案区分）
  continuousVoice: boolean; // 连续对话进行中（免唤醒词自动续听；瞬态，不持久化）
  expr: DflyExpr; // avatar expression driven by the latest reply's emotion tag
  avatarMode: "dragonfly" | "digitalhuman";
  avatarVisible: boolean; // 形象区默认显隐（设置 → 通用可改，重启后保持）
  llmConfig: LlmConfigInfo | null; // my per-user model settings (key never leaves server)
  mcpServers: McpServerInfo[] | null; // 生效视图：全局 + 我的（同名覆盖）
  globalMcpServers: McpServerInfo[] | null; // 全局原始列表（仅管理员拉取）
  skills: SkillInfo[] | null; // 生效视图：全局 + 我的（同名覆盖）
  globalSkills: SkillInfo[] | null; // 全局原始列表（仅管理员拉取）
  myRelay: MyRelayStatus | null; // 网络中继：我的开关 + 管理员总开关 + 桌面在线
  adminRelayConfig: RelayConfigInfo | null; // 网络中继管理页（总开关+白名单+统计）
  browser: BrowserState; // built-in browser surface (embedded pane / popup)

  login(serverUrl: string, username: string, password: string): Promise<void>;
  register(
    serverUrl: string,
    employeeId: string,
    username: string,
    password: string,
  ): Promise<void>;
  /** 清除登录屏提示/待审核等待页（返回登录、切换登录/注册时调用）。 */
  dismissNotices(): void;
  /** 本人修改密码；成功后自动登出并提示重新登录（服务端使旧 token 全部失效）。 */
  changeMyPassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<"ok" | "bad_credentials" | "bootstrap" | "fail">;
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
  setUserRole(username: string, role: "admin" | "reviewer" | "user"): Promise<boolean>;
  setUserDisabled(username: string, disabled: boolean): Promise<boolean>;
  /** 待审核注册列表（管理员与审核员）。 */
  listReviewUsers(): Promise<AdminUserDetail[]>;
  /** 通过/拒绝一个注册申请（管理员与审核员）。 */
  decideReviewUser(username: string, approve: boolean): Promise<boolean>;
  /** 管理员重置某用户密码（无需旧密码；目标用户被强制下线）。 */
  resetUserPassword(username: string, password: string): Promise<boolean>;
  /** 管理员强制某在线用户下线（不禁用账号）。 */
  kickUser(username: string): Promise<boolean>;
  /** 拉取最近的管理动作审计（仅管理员），成功后写入 auditLog。 */
  loadAuditLog(limit?: number): Promise<boolean>;
  selectSession(id: string): Promise<void>;
  selectSharedSession(id: string): Promise<void>;
  setSessionShare(id: string, shared: boolean, sharedWith?: string[]): Promise<void>;
  listUsers(): Promise<UserSummary[]>;
  loadShared(): Promise<void>;
  ownerOnlineOf(sessionId: string): boolean;
  loadLlmConfig(): Promise<void>;
  saveLlmConfig(patch: UpdateLlmConfigRequest): Promise<void>;
  clearLlmConfig(): Promise<void>;
  // 网络中继（用户开关在设置面板；管理员配置在管理页）。
  loadMyRelay(): Promise<void>;
  setMyRelayOptIn(on: boolean): Promise<void>;
  loadAdminRelayConfig(): Promise<void>;
  saveAdminRelayConfig(patch: RelayConfigUpdate): Promise<void>;
  // MCP 服务器管理（保存后新会话生效）。失败时抛出已翻译的 Error。
  loadMcpServers(): Promise<void>;
  saveMcpServer(name: string, def: McpServerDef): Promise<void>;
  deleteMcpServer(name: string): Promise<void>;
  importMcpServers(json: string): Promise<ImportMcpResult>;
  /** 官方 Registry 市场搜索（结果由面板自持，不进全局 store）。 */
  searchMcpRegistry(q: string, cursor?: string): Promise<McpRegistrySearchResponse>;
  // 全局 MCP（仅管理员）。
  loadGlobalMcpServers(): Promise<void>;
  saveGlobalMcpServer(name: string, def: McpServerDef): Promise<void>;
  deleteGlobalMcpServer(name: string): Promise<void>;
  importGlobalMcpServers(json: string): Promise<ImportMcpResult>;
  // 专家技能管理（安装后对新会话生效）。失败时抛出已翻译的 Error。
  loadSkills(): Promise<void>;
  /** 安装/更新一个技能（SKILL.md 全文；同名即更新）。 */
  saveSkill(name: string, markdown: string): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  importSkills(json: string): Promise<ImportSkillsResult>;
  /** 专家市场安装（服务端按 url 下载 SKILL.md）。 */
  installSkill(name: string, url: string): Promise<void>;
  /** 市场搜索（结果由面板自持，不进全局 store）。 */
  searchSkillRegistry(q: string): Promise<SkillRegistrySearchResponse>;
  // 全局技能（仅管理员）。
  loadGlobalSkills(): Promise<void>;
  /** 安装/更新全局技能（SKILL.md 全文；同名即更新）。 */
  saveGlobalSkill(name: string, markdown: string): Promise<void>;
  deleteGlobalSkill(name: string): Promise<void>;
  importGlobalSkills(json: string): Promise<ImportSkillsResult>;
  installGlobalSkill(name: string, url: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  moveSession(id: string, projectId: string | null): Promise<void>;
  /** 重命名自己的会话（空标题不提交；仅自己的会话可改）。 */
  renameSession(id: string, title: string): Promise<boolean>;
  setCurrentAgent(agentId: string): void;
  /** 输入框草稿放 store：发送失败（ack 超时/断线）时能把文本放回去。 */
  draft: string;
  setDraft(text: string): void;
  appendDraft(text: string): void;
  /** 发送一条用户消息；false = 未发出（断线），草稿保留。 */
  send(text: string): boolean;
  interrupt(): void;
  respondPermission(allow: boolean): void;
  respondExec(allow: boolean, trustFromNow: boolean): void;
  setTrustMode(on: boolean): void;
  setAutoRead(on: boolean): void;
  setRecording(on: boolean): void;
  /** 语音唤醒配置/麦克风错误（null = 一切正常）。 */
  setWakeError(msg: string | null): void;
  /** 连续对话模式开/关（由唤醒编排与 ⏹ 逃生口设置）。 */
  setContinuousVoice(on: boolean): void;
  speak(text: string, opts?: { voice?: string; rate?: number; volume?: number }): void;
  stopSpeaking(): void;
  setExpr(expr: DflyExpr, holdMs?: number): void;
  setAvatarMode(mode: "dragonfly" | "digitalhuman"): void;
  setAvatarVisible(on: boolean): void;
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
