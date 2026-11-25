import type {
  AttachmentImage,
  DiagResult,
  ServerMessage,
  UpdateRequestStatus,
  UpdateRequestView,
} from "@blm/protocol";
import { Store, sharedWithUser, type ProjectRecord, type SessionRecord, type TaskRecord } from "../store.js";
import { AgentSession } from "./AgentSession.js";
import { ConnectionRegistry } from "./connections.js";
import { MessageRouter } from "./messageRouter.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { TaskManager, type CreateTaskInput, type TaskFlowInput, type FlowResult } from "./taskManager.js";
import { deleteProjectSchedules as deleteProjectSchedulesImpl } from "../scheduleStore.js";
import { listProjectSchedules, deleteSchedulesForUser, loadAll as loadSchedulesAll } from "../scheduleStore.js";
import { UpdateRequestManager } from "./updateRequests.js";
import { storeDiagResult } from "../diagStore.js";
import { DiagTaskManager } from "../diagTaskManager.js";
// 用户删除级联需要触及的各用户级存储。
import { clearUserLlmConfig } from "../llmConfig.js";
import { deleteUserMcp } from "../mcpConfig.js";
import { clearUserWorkflows } from "../workflowConfig.js";
import { deleteUserSkillDir } from "../skillsConfig.js";
import { setRelayOptIn } from "../relay/relayConfig.js";
import { setPublicExecAuthorized } from "../publicExecAuth.js";
import { deleteDiagEntriesFor } from "../diagStore.js";

// Routes messages between WebSocket connections and per-session agent loops.
// Server messages are broadcast to every connection of the owning user; shared
// sessions additionally reach all connected users (see ConnectionRegistry).
// The work is split across three helpers; this class is the public facade used
// by the WS handler and the REST routes.

export class AgentManager {
  private store: Store;
  private sessions = new Map<string, AgentSession>(); // session_id -> session
  private conns: ConnectionRegistry;
  private registry: SessionRegistry;
  private router: MessageRouter;
  private updateRequests: UpdateRequestManager;
  private tasks: TaskManager;
  /** 远程诊断任务（管理员借用在线客户端的智能体排障）。 */
  diagTasks: DiagTaskManager;

  constructor(store: Store) {
    this.store = store;
    this.conns = new ConnectionRegistry(store);
    this.registry = new SessionRegistry(store);
    this.updateRequests = new UpdateRequestManager(store, this.conns);
    this.tasks = new TaskManager(store, this.conns, this.registry);
    this.diagTasks = new DiagTaskManager(store, this);
    // 工作台跟随指派：本机执行/审批的目标由任务当前负责人决定；共享会话
    // 一律钉死会话主人（使用方只是借用宿主的能力与信息，不能把操作引到
    // 自己机器上）。
    this.conns.execTargetResolver = (sid) => this.tasks.executorOf(sid);
    this.router = new MessageRouter(store, this.conns, this.sessions, this.updateRequests, this.tasks);
    // 诊断任务的空闲结算钩子（先于一切消息入口注入）。
    this.router.onIdleHook = (sessionId) => {
      const task = this.diagTasks
        .list()
        .find((e) => e.session_id === sessionId && e.status === "running");
      if (task) this.diagTasks.onTurnEnd(task.task_id);
    };
  }

  // ---------- connections ----------

  registerConnection(
    userId: string,
    send: (msg: ServerMessage) => void,
    close?: () => void,
    kind?: "mobile",
  ): () => void {
    return this.conns.registerConnection(userId, send, close, kind);
  }

  /** 账号被禁用：通知并断开该用户的全部连接。 */
  dropUser(userId: string): void {
    this.conns.dropUser(userId, {
      type: "error",
      session_id: null,
      code: "account_disabled",
      message: "账号已被禁用，如有疑问请联系管理员。",
    });
  }

  /** 管理员强制下线：通知并断开该用户的全部连接（区别于禁用）。 */
  kickUser(userId: string): void {
    this.conns.dropUser(userId, {
      type: "error",
      session_id: null,
      code: "kicked",
      message: "您已被管理员强制下线。",
    });
  }

  /** 发给某用户的全部连接（注册审核实时提醒等）。离线则为 no-op。 */
  sendToUser(userId: string, msg: ServerMessage): void {
    this.conns.broadcast(userId, msg);
  }

  /** Whether the user currently has at least one live WS connection. */
  isOnline(userId: string): boolean {
    return this.conns.isOnline(userId);
  }

  /**
   * Drop the user's idle agent sessions so the next message restarts them with
   * the current LLM settings. Running sessions are left alone (next turn wins).
   */
  disposeIdleSessions(userId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.record.user_id !== userId || session.isBusy) continue;
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /** 全局配置（MCP 服务器等）变更后调用：丢弃所有用户的空闲会话，下一条消息用新配置重建。 */
  disposeAllIdleSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.isBusy) continue;
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /** 项目元数据（描述）变更后调用：丢弃该项目下所有用户的空闲
   *  会话，下一条消息按新描述重建（描述影响项目的全部会话，不只
   *  是编辑者自己的）。忙会话不打断，自然空闲后生效。 */
  disposeProjectIdleSessions(projectId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.record.project_id !== projectId || session.isBusy) continue;
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 删除用户账号的前置挡板：若该用户是某个**在途**协作任务的需求方或当前环节
   * 负责人，或仍启用着定时任务，返回 false——先把协作线程/定时任务收尾再删。
   */
  userDeletionBlocked(username: string): boolean {
    const activeTaskInvolved = this.store.listTasks().some((t) => {
      if (t.status !== "active") return false;
      if (t.requester === username) return true;
      const cur = t.stages.find((s) => s.key === t.current_stage);
      return cur?.assignee === username;
    });
    if (activeTaskInvolved) return true;
    // 启用中的定时任务（enabled 即活跃；disabled 的不挡）。
    return Object.values(loadSchedulesAll()).some(
      (r) => r.owner === username && r.enabled,
    );
  }

  /**
   * 删除用户账号（管理员）。路由先做 userDeletionBlocked 判定（有在途任务 /
   * 启用定时 → 409），再调此方法执行全量级联清理：
   * 会话（含共享引用与专属会话）、项目（含公域空间与定时项目）、定时任务、
   * 协作任务记录、LLM/MCP/工作流模板/技能/中继 opt-in/公域授权/诊断存档/
   * 更新申请。全部步骤幂等。users.json 的账号移除由路由层在级联之后完成。
   */
  deleteUserAfterGuard(username: string): { ok: true } {
    // 1) 通知并断开其全部连接（已删账号的 token 无意义）。
    this.conns.dropUser(username, {
      type: "error",
      session_id: null,
      code: "account_deleted",
      message: "您的账号已被管理员删除。",
    });
    // 2) 会话：走完整 deleteSession（含 dispose、forceFinish 任务线程、
    //    session_unshared 广播给原共享可见者——在线协作端据此摘除 tab）。
    for (const sid of this.store.listAllSessions()) {
      if (sid.user_id !== username) continue;
      this.deleteSession(username, sid.session_id);
    }
    // 3) 项目：其拥有的全部项目（含公域）。用户的公域项目是"其本人拥有但
    //    性质公共"，删除对的正是 owner 本人，不走 canManageProject 的
    //    管理员门槛；公域项目需先拒绝其名下待审申请（申请人可能是别人）。
    for (const proj of this.store.listAllProjects()) {
      if (proj.user_id !== username) continue;
      if (proj.visibility === "public") {
        this.updateRequests.rejectAllForProject(proj.project_id, "项目作者已删除");
      }
      // 定时任务项目：级联删其定时任务与专属会话（宿主没了没意义）。
      const schedSessions = listProjectSchedules(proj.project_id)
        .map((r) => r.session_id)
        .filter((id): id is string => !!id);
      for (const sid of schedSessions) this.deleteSession(username, sid);
      deleteProjectSchedulesImpl(proj.project_id);
      this.registry.deleteProjectRecord(proj.project_id);
    }
    // 4) 定时任务与其专属会话：deleteSchedulesForUser 返回被删任务清单。
    for (const sched of deleteSchedulesForUser(username)) {
      if (sched.session_id) {
        this.sessions.get(sched.session_id)?.dispose();
        this.sessions.delete(sched.session_id);
        this.store.deleteSession(sched.session_id);
      }
    }
    // 5) 协作任务记录：已完结且用户是需求方的删记录（会话已在第 2 步删）；
    //    被列在某环节 assignee 的（done 任务）从环节摘掉。
    for (const t of this.store.listTasks()) {
      if (t.requester === username) {
        this.store.deleteTask(t.task_id);
        continue;
      }
      if (t.stages.some((s) => s.assignee === username)) {
        t.stages = t.stages.map((s) => (s.assignee === username ? { key: s.key, name: s.name } : s));
        this.store.saveTask(t);
      }
    }
    // 6) 其它用户会话对它的共享引用剔除。
    this.store.stripUserFromSharedSessions(username);
    // 7) 用户级配置面。
    clearUserLlmConfig(username);
    deleteUserMcp(username);
    clearUserWorkflows(username);
    deleteUserSkillDir(username);
    setRelayOptIn(username, false);
    setPublicExecAuthorized(username, false);
    deleteDiagEntriesFor(username);
    this.diagTasks.deleteForUser(username);
    this.store.deleteUpdateRequestsFor(username);
    // 8) 账号记录移除由路由层在级联之后执行（本方法只清数据面，不含 users.json）。
    return { ok: true };
  }

  // ---------- sessions ----------

  createSession(
    userId: string,
    agentId: string,
    title?: string,
    projectId?: string | null,
  ): SessionRecord | null {
    return this.registry.createSession(userId, agentId, title, projectId);
  }

  listSessions(userId: string) {
    return this.registry.listSessions(userId);
  }

  /** 某会话引擎当前是否在跑（未建/已空闲回收 = false）。定时调度避让用。 */
  isSessionBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isBusy ?? false;
  }

  /** WS 连接建立补推：该用户可见（自有或共享可见）且引擎在跑的
   *  会话忙闲状态。共享会话由别人驱动时，协作者重连后也能看到忙碌。 */
  busyTurnStatesFor(userId: string): ServerMessage[] {
    const out: ServerMessage[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.isBusy) continue;
      const rec = this.store.getSession(sessionId);
      if (!rec) continue;
      if (rec.user_id === userId || (rec.shared && sharedWithUser(rec, userId))) {
        out.push({ type: "turn_state", session_id: sessionId, busy: true });
      }
    }
    return out;
  }

  // ---------- projects ----------

  createProject(
    userId: string,
    input: {
      name: string;
      agentId: string;
      visibility?: "personal" | "public";
      kind?: "standard" | "collab" | "scheduled";
      workflow?: import("@blm/protocol").ProjectWorkflow;
      description?: string;
    },
  ) {
    return this.registry.createProject(userId, input);
  }

  /** 设置协作项目的环节链（个人项目=本人可改）。
   *  环节只影响之后新建的任务，在途任务按建任务快照不变。 */
  setProjectWorkflow(
    userId: string,
    projectId: string,
    stages: import("@blm/protocol").WorkflowStage[],
  ): { ok: true } | { ok: false; code: "not_found" | "forbidden" } {
    return this.registry.setProjectWorkflow(userId, projectId, stages)
      ? { ok: true }
      : { ok: false, code: "not_found" };
  }

  /** 设置项目描述（个人项目=本人；公有域项目=公有域管理员）。
   *  与 deleteProject 同一归属模型：非归属者 403。 */
  setProjectDescription(
    userId: string,
    projectId: string,
    description: string,
  ): { ok: true; rec: ProjectRecord } | { ok: false; code: "not_found" | "forbidden" } {
    const proj = this.store.getProject(projectId);
    if (!proj) return { ok: false, code: "not_found" };
    if (!this.registry.canManageProject(userId, proj)) return { ok: false, code: "forbidden" };
    if ((proj.description ?? "") === description) return { ok: true, rec: proj };
    const rec = this.store.updateProjectDescription(projectId, description);
    if (!rec) return { ok: false, code: "not_found" };
    // 描述随会话注入提示词：回收空闲会话，下一条消息按新描述重建。
    this.disposeProjectIdleSessions(projectId);
    return { ok: true, rec };
  }

  listProjects(userId: string) {
    return this.registry.listProjects(userId);
  }

  deleteProject(
    userId: string,
    projectId: string,
  ): { ok: true } | { ok: false; code: "not_found" | "forbidden" } {
    const proj = this.store.getProject(projectId);
    if (!proj) return { ok: false, code: "not_found" };
    if (!this.registry.canManageProject(userId, proj)) return { ok: false, code: "forbidden" };
    // 公有域项目删除：待审申请一并自动拒绝并通知申请人。
    if (proj.visibility === "public") {
      this.updateRequests.rejectAllForProject(projectId, "项目已删除");
    }
    // 定时任务项目删除：其中定时任务一并删除（参照会话降级语义的收紧：
    // 定时任务没了项目就没有宿主配置，保留只会继续在默认空间触发）。
    // 级联前先取引用，专属会话/历史一并收走（宿主删了记录不留）。
    const schedSessions = listProjectSchedules(projectId)
      .map((r) => r.session_id)
      .filter((id): id is string => !!id);
    for (const sid of schedSessions) this.deleteSession(proj.user_id, sid);
    deleteProjectSchedulesImpl(projectId);
    return this.registry.deleteProjectRecord(projectId)
      ? { ok: true }
      : { ok: false, code: "not_found" };
  }

  /** 定时任务的归属校验（scheduleRoutes 用）：项目须存在、本人可用
   *  且类型为 scheduled。 */
  validateScheduleProject(
    userId: string,
    projectId: string,
  ): { ok: true } | { ok: false; code: "not_found" | "forbidden" | "bad_project" } {
    const proj = this.store.getProject(projectId);
    if (!proj || !this.registry.canUseProjectFor(userId, proj)) {
      return { ok: false, code: projectId ? "bad_project" : "not_found" };
    }
    if ((proj.kind ?? "standard") !== "scheduled") return { ok: false, code: "bad_project" };
    return { ok: true };
  }

  listSharedSessions(userId: string) {
    return this.registry.listSharedSessions(userId, (uid) => this.isOnline(uid));
  }

  setShared(
    userId: string,
    sessionId: string,
    shared: boolean,
    sharedWith?: string[],
    approvers?: string[],
  ): SessionRecord | null {
    const oldRec = this.store.getSession(sessionId);
    const newRec = this.registry.setShared(userId, sessionId, shared, sharedWith, approvers);
    if (newRec && this.shareChanged(oldRec, newRec)) {
      this.conns.broadcastSharedChange(
        newRec.user_id,
        newRec.session_id,
        oldRec?.shared ?? false,
        oldRec?.shared_with,
        newRec.shared ?? false,
        newRec.shared_with,
        // 新增可见者：session_created（客户端 upsert 进共享列表，零新增代码）。
        {
          type: "session_created",
          session: this.metaOf(newRec),
        },
      );
    }
    return newRec;
  }

  /** SessionRecord → 对外 SessionMeta 投影（与 taskManager.metaOf 同构）。 */
  private metaOf(rec: SessionRecord) {
    return {
      session_id: rec.session_id,
      title: rec.title,
      agent_id: rec.agent_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      project_id: rec.project_id ?? null,
      shared: rec.shared ?? false,
      shared_with: rec.shared_with ?? [],
      ...(rec.approvers?.length ? { approvers: rec.approvers } : {}),
      owner: rec.user_id,
    };
  }

  /** 共享设置是否真的变了（避免全员共享无变化时也重推一遍）。 */
  private shareChanged(
    oldRec: SessionRecord | null,
    newRec: SessionRecord,
  ): boolean {
    const a = oldRec?.shared ?? false;
    const b = newRec.shared ?? false;
    if (a !== b) return true;
    if (!a) return false; // 都在未共享态
    // 都在共享态：只对比 shared_with（approvers 变化不影响可见列表）。
    const al = oldRec?.shared_with ?? [];
    const bl = newRec.shared_with ?? [];
    if (al.length !== bl.length) return true;
    const setB = new Set(bl);
    return al.some((u) => !setB.has(u));
  }

  deleteSession(
    userId: string,
    sessionId: string,
  ): { ok: true } | { ok: false; code: "not_found" } {
    // Stop the live engine first so it cannot append to a record being removed.
    if (!this.registry.isOwner(userId, sessionId)) return { ok: false, code: "not_found" };
    // 协作任务线程：删除=放弃任务（会话主人就是任务需求方，非需求方
    // 过不了 isOwner）。发起方随时可删——在途任务强制收尾为取消并推
    // task_update（不走 flow 守卫，卡住的任务也删得掉）；done 后直接
    // 删，任务记录保留（客户端列表降级灰显）。
    const rec = this.store.getSession(sessionId);
    if (rec?.task_id) {
      this.tasks.forceFinish(rec.task_id);
    }
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
    this.registry.deleteSession(userId, sessionId);
    // 共享会话被主人删除：原共享可见者收 session_unshared 摘除（在线者）。
    if (rec?.shared) {
      this.conns.broadcastSharedChange(
        rec.user_id,
        sessionId,
        true,
        rec.shared_with,
        false,
        undefined,
      );
    }
    return { ok: true };
  }

  moveSession(
    userId: string,
    sessionId: string,
    projectId: string | null,
  ): { ok: true; rec: SessionRecord } | { ok: false; code: "not_found" | "cross_visibility" } {
    return this.registry.moveSession(userId, sessionId, projectId);
  }

  /** 重命名自己的会话（仅标题；历史与共享状态不变）。 */
  renameSession(
    userId: string,
    sessionId: string,
    title: string,
  ): { ok: true; rec: SessionRecord } | { ok: false; code: "not_found" | "forbidden" } {
    const oldRec = this.store.getSession(sessionId);
    const result = this.registry.renameSession(userId, sessionId, title);
    // 共享会话标题更新：可见集合不变，broadcastSharedChange 差分不会触发，
    // 这里把最新 meta 广播给全体在线可见者（客户端 session_created 分支
    // 会 upsert 刷新列表标题）。主人自身经 REST 响应更新。
    if (result.ok && (oldRec?.shared ?? false)) {
      this.conns.broadcastSharedMetaUpdate(
        result.rec.user_id,
        result.rec.session_id,
        result.rec.shared_with,
        { type: "session_created", session: this.metaOf(result.rec) },
      );
    }
    return result;
  }

  /** 任务当前负责人（无协作任务/记录缺失时为 null）。LLM 中继据此选代发桌面。 */
  executorOf(sessionId: string): string | null {
    return this.tasks.executorOf(sessionId);
  }

  // ---------- 协作流任务 ----------

  createTask(userId: string, input: CreateTaskInput): TaskRecord {
    return this.tasks.createTask(userId, input);
  }

  flowTask(userId: string, taskId: string, input: TaskFlowInput): FlowResult {
    return this.tasks.flow(userId, taskId, input);
  }

  listTasks(userId: string): TaskRecord[] {
    return this.tasks.listFor(userId);
  }

  /** 删除已完结任务记录（需求方；幽灵灰显条目清理）。 */
  deleteTask(
    userId: string,
    taskId: string,
  ): "ok" | "not_found" | "forbidden" | "bad_status" {
    return this.tasks.deleteTask(userId, taskId);
  }

  /** WS 连接建立补推：未完结任务。 */
  activeTasksFor(userId: string): TaskRecord[] {
    return this.tasks.activeFor(userId);
  }

  /** 存量任务迁移到 v2（启动时调用一次，先于一切 REST/WS 入口）。 */
  migrateLegacyTasks(): void {
    this.tasks.migrateLegacyTasks();
  }

  // ---------- 公有域更新申请 ----------

  listUpdateRequests(userId: string, status?: UpdateRequestStatus): UpdateRequestView[] {
    return this.updateRequests.listFor(userId, status);
  }

  getUpdateRequestDetail(userId: string, requestId: string) {
    return this.updateRequests.detail(userId, requestId);
  }

  decideUpdateRequest(
    userId: string,
    requestId: string,
    approve: boolean,
    reason?: string,
  ) {
    return this.updateRequests.decide(userId, requestId, approve, reason);
  }

  getHistory(userId: string, sessionId: string) {
    return this.registry.getHistory(userId, sessionId);
  }

  // ---------- WS routing ----------

  handleUserMessage(userId: string, sessionId: string, text: string, clientMsgId?: string): void {
    this.router.handleUserMessage(userId, sessionId, text, clientMsgId);
  }

  handleInterrupt(userId: string, sessionId: string): void {
    this.router.handleInterrupt(userId, sessionId);
  }

  handleRegenerate(userId: string, sessionId: string): void {
    this.router.handleRegenerate(userId, sessionId);
  }

  handleRecallMessage(userId: string, sessionId: string, ordinal: number, prefix: string): void {
    void this.router.handleRecallMessage(userId, sessionId, ordinal, prefix);
  }

  handlePermissionResponse(userId: string, requestId: string, allow: boolean): void {
    this.router.handlePermissionResponse(userId, requestId, allow);
  }

  /** Route a client's local-execution result back to the waiting session. */
  handleToolExecResult(
    userId: string,
    requestId: string,
    result: { ok: boolean; output?: string; error?: string; images?: AttachmentImage[] },
  ): void {
    this.router.handleToolExecResult(userId, requestId, result);
  }

  /** 推送诊断请求给目标用户的全部在线连接。 */
  sendDiagRequest(
    userId: string,
    requestId: string,
    scope: "layout" | "screenshot",
  ): void {
    this.conns.broadcast(userId, { type: "diag_request", request_id: requestId, scope });
  }

  /** Route a diag_result to the diag store (id-keyed). */
  handleDiagResult(userId: string, result: DiagResult): void {
    storeDiagResult(userId, result);
  }

  /** Stop the current run without closing the session (used on interrupt). */
  markIdleAfterInterrupt(sessionId: string): void {
    // The consume loop's finally block handles idle scheduling; nothing extra needed.
  }
}
