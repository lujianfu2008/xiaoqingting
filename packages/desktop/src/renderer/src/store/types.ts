import type {
  AdminUserDetail,
  AgentInfo,
  AuditEntry,
  Block,
  CreateTaskRequest,
  CreateScheduleRequest,
  FlowAction,
  ImportMcpResult,
  ImportSkillsResult,
  LlmConfigInfo,
  McpRegistrySearchResponse,
  McpServerDef,
  MyRelayStatus,
  RelayConfigInfo,
  RelayConfigUpdate,
  ScheduleView,
  SkillRegistrySearchResponse,
  McpServerInfo,
  ProjectMeta,
  SkillInfo,
  SessionMeta,
  TaskView,
  UpdateRequestView,
  UpdateScheduleRequest,
  UpsertWorkflowRequest,
  Usage,
  UserSummary,
  UpdateLlmConfigRequest,
  WorkflowInfo,
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

/** 一条待发附件（按会话隔离；dataUrl 仅图片缩略图）。 */
export interface SessionAttachment {
  name: string;
  path: string; // absolute path on this machine
  dataUrl?: string;
}

/** 阅读器一个 tab：一个正在看的本机文件。 */
export interface ViewerTab {
  id: string;
  path: string; // absolute path
  name: string; // file name (tab label)
  size: number; // bytes (0 = unknown)
}

/** 内置文件阅读器 pane 状态（多 tab，只读）。 */
export interface ViewerState {
  open: boolean;
  tabs: ViewerTab[];
  activeId: string | null;
  /** 左侧文件浏览树当前根目录（跟随最近打开文件的目录）。 */
  treeRoot: string | null;
  /** 文件树折叠（▸ 竖条）；树右缘的宽度拖条随之隐藏。 */
  treeCollapsed: boolean;
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
  // 任务/协作流轻提示：数秒后自动消失的信息条（区别于需人工处理的 error）。
  notice: string | null;
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
  tasks: TaskView[]; // 协作流任务线程（我是需求方/研发/测试的）；客户端按 session_id 反查
  auditLog: AuditEntry[]; // 管理动作审计（最近在前，仅管理页拉取）
  pendingReviewCount: number; // 待审核注册数（WS 实时推送 + 上线补推，审核员/管理员可见）
  presence: Record<string, boolean>; // username -> online, seeded via REST + WS deltas
  currentSessionId: string | null;
  sharedView: boolean; // true while viewing someone else's shared session
  // 打开的会话 tab（顺序即 tab 顺序；进入的会话自动成 tab）。
  openTabs: string[];
  agents: AgentInfo[];
  currentAgentId: string;
  // 附件随会话走（tab 并开时互不串）。附件确认键为会话 id。
  attachments: Record<string, SessionAttachment[]>;
  blocksBySession: Record<string, Block[]>;
  streaming: Record<string, string>;
  busy: Record<string, boolean>;
  usageBySession: Record<string, Usage>; // 最近一次回复的 token 用量（result 推送）
  // 草稿随会话走（tab 并开时互不串）；未选中会话时键为 ""。
  draftsBySession: Record<string, string>;
  // 并发审批队列（FIFO，弹窗渲染队首）：子代理/主线程可能同时发起多个
  // 审批，单槽位会互相覆盖。result/error 到达时清空对应会话的队列。
  pendingPermission: WsPermissionRequest[];
  pendingExec: WsToolExecRequest[];
  trustMode: boolean;
  autoRead: boolean;
  // 后台完成通知（回合完成/审批请求的系统通知；设置 → 常规可关）。
  notifyEnabled: boolean;
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
  workflows: WorkflowInfo[] | null; // 生效视图：内置 + 全局 + 我的（同名覆盖）
  globalWorkflows: WorkflowInfo[] | null; // 全局原始列表（仅管理员拉取）
  schedules: ScheduleView[]; // 定时任务（owner 私有；REST 播种 + WS schedule_update）
  myRelay: MyRelayStatus | null; // 网络中继：我的开关 + 管理员总开关 + 桌面在线
  adminRelayConfig: RelayConfigInfo | null; // 网络中继管理页（总开关+白名单+统计）
  browser: BrowserState; // built-in browser surface (embedded pane / popup)
  viewer: ViewerState; // 内置文件阅读器（只读，多 tab）
  // agent 读取文件时自动弹出阅读器（默认关；设置 → 常规）。
  viewerAutoOpen: boolean;

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
    description?: string;
    agentId: string;
    folder: "auto" | "choose";
    visibility?: "personal" | "public";
  }): Promise<ProjectMeta | null>;
  deleteProject(id: string): Promise<void>;
  /** 设置项目描述（个人=本人；公域=管理员）；空串 = 清空。 */
  updateProjectDescription(id: string, description: string): Promise<boolean>;
  loadUpdateRequests(): Promise<void>;
  /** 批准/拒绝一条公有域更新申请（仅管理员）。 */
  decideUpdateRequest(id: string, approve: boolean, reason?: string): Promise<boolean>;
  // 协作流任务（可自定义工作流模板）。
  loadTasks(): Promise<void>;
  /** 创建任务线程（同时建绑定会话）；null = 失败。 */
  createTask(input: CreateTaskRequest): Promise<TaskView | null>;
  /** 推进流转；false = 服务端拒绝（错误已提示）。target = assign 的人，stageKey = send_back/assign 的环节。 */
  flowTask(
    taskId: string,
    action: FlowAction,
    opts?: { target?: string; stageKey?: string; note?: string },
  ): Promise<boolean>;
  /** 删除已完结的任务记录（需求方；含绑定会话已删的幽灵条目）。 */
  deleteTask(taskId: string): Promise<void>;
  listAdminUsers(): Promise<AdminUserDetail[]>;
  setUserRole(username: string, role: "admin" | "reviewer" | "user"): Promise<boolean>;
  /** 授权/撤销某工号在公有域会话的服务端命令执行（仅管理员）。 */
  setUserPublicExec(username: string, enabled: boolean): Promise<boolean>;
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
  /** 拉取一个会话的全量历史替换本地缓存（服务端为权威；失败保留缓存并报错）。 */
  fetchSessionHistory(id: string): Promise<void>;
  /** 重连后逐个重拉已打开会话的历史（服务端不回放聊天，错过窗口只能重拉补齐）。 */
  refreshOpenSessions(): Promise<void>;
  setSessionShare(id: string, shared: boolean, sharedWith?: string[], approvers?: string[]): Promise<void>;
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
  // 工作流模板管理（模板名即主键；失败时抛出已翻译的 Error）。
  loadWorkflows(): Promise<void>;
  saveWorkflow(name: string, body: UpsertWorkflowRequest): Promise<void>;
  deleteWorkflow(name: string): Promise<void>;
  // 全局模板（仅管理员）。
  loadGlobalWorkflows(): Promise<void>;
  saveGlobalWorkflow(name: string, body: UpsertWorkflowRequest): Promise<void>;
  deleteGlobalWorkflow(name: string): Promise<void>;
  // 定时任务管理（失败时抛出已翻译的 Error）。
  loadSchedules(): Promise<void>;
  createSchedule(input: CreateScheduleRequest): Promise<ScheduleView>;
  updateSchedule(id: string, input: UpdateScheduleRequest): Promise<void>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<void>;
  /** 立即执行一轮；返回最新记录（被跳过时 last_skip_reason 有值，由面板提示）。 */
  triggerSchedule(id: string): Promise<ScheduleView>;
  deleteSchedule(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  moveSession(id: string, projectId: string | null): Promise<void>;
  /** 重命名自己的会话（空标题不提交；仅自己的会话可改）。 */
  renameSession(id: string, title: string): Promise<boolean>;
  setCurrentAgent(agentId: string): void;
  setDraft(text: string): void;
  appendDraft(text: string): void;
  /** 关闭一个会话 tab（不删会话；关当前 tab 时落到相邻 tab）。 */
  closeTab(id: string): void;
  /** 发送一条用户消息；false = 未发出（断线），草稿保留。 */
  send(text: string): boolean;
  /** 重新生成：对当前会话最后一条用户消息再跑一轮回复。 */
  regenerate(): void;
  interrupt(): void;
  respondPermission(requestId: string, allow: boolean): void;
  respondExec(requestId: string, allow: boolean, trustFromNow: boolean): void;
  setTrustMode(on: boolean): void;
  setAutoRead(on: boolean): void;
  /** 后台完成通知开关（localStorage 持久化，默认开）。 */
  setNotifyEnabled(on: boolean): void;
  setRecording(on: boolean): void;
  /** 添加待发附件（进当前会话的附件列表）。 */
  addAttachments(items: SessionAttachment[]): void;
  /** 移除当前会话的第 i 个待发附件。 */
  removeAttachment(index: number): void;
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
  /** Tab focus moved: main shows only that session's browser page. */
  setBrowserActiveSession(sessionId: string | null): void;
  setBrowserMode(mode: "embedded" | "popup"): Promise<void>;
  closeBrowser(): Promise<void>;
  // 内置文件阅读器（只读）。
  /** 打开若干本机文件（按 path 去重；已开的直接激活）。 */
  openViewerFiles(paths: string[]): void;
  /** 关一个 tab（关最后 → pane 收起）。 */
  closeViewerTab(id: string): void;
  activateViewerTab(id: string): void;
  /** 展开/收起 pane（无 tab 时不可凭空展开）。 */
  setViewerOpen(on: boolean): void;
  /** agent 读取文件时自动弹出阅读器（localStorage 持久化，默认关）。 */
  setViewerAutoOpen(on: boolean): void;
  /** 文件树折叠/展开（折叠时宽度拖条隐藏）。 */
  setTreeCollapsed(on: boolean): void;
}

// Actions that never prompt again while trust mode is on (includes command
// execution, per user request — trust mode means fully autonomous operation).
// Work-dir/space settings are excluded on purpose: they are user-only
// actions done in the settings UI, never auto-executable for the agent.
export const TRUSTABLE_ACTIONS = new Set([
  "run_command",
  "read_file",
  "read_attachment",
  "write_file",
  "list_dir",
  "get_workdir",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_close",
]);

/**
 * 协作流任务的当前负责人（工作台跟随指派）：agent 的本机执行、审批应答、
 * 发言守卫都跟随此用户。与服务端 TaskManager.executorOf 同一规则（两边必须
 * 同步改）：当前环节负责人兜底需求方（环节未指派）；已完结回需求方。无任务
 * 的会话调用方回退会话主人。
 */
export function executorOfTask(task: TaskView): string {
  if (task.status !== "active" || !task.current_stage) return task.requester;
  const cur = task.stages.find((s) => s.key === task.current_stage);
  return cur?.assignee ?? task.requester;
}
