import type { AttachmentImage, ServerMessage, UpdateRequestStatus, UpdateRequestView } from "@blm/protocol";
import { Store, sharedWithUser, type ProjectRecord, type SessionRecord, type TaskRecord } from "../store.js";
import { AgentSession } from "./AgentSession.js";
import { ConnectionRegistry } from "./connections.js";
import { MessageRouter } from "./messageRouter.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { TaskManager, type CreateTaskInput, type TaskFlowInput, type FlowResult } from "./taskManager.js";
import { UpdateRequestManager } from "./updateRequests.js";

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

  constructor(store: Store) {
    this.store = store;
    this.conns = new ConnectionRegistry(store);
    this.registry = new SessionRegistry(store);
    this.updateRequests = new UpdateRequestManager(store, this.conns);
    this.tasks = new TaskManager(store, this.conns, this.registry);
    // 工作台跟随指派：本机执行/审批的目标由任务当前负责人决定；共享会话
    // 一律钉死会话主人（使用方只是借用宿主的能力与信息，不能把操作引到
    // 自己机器上）。
    this.conns.execTargetResolver = (sid) => this.tasks.executorOf(sid);
    this.router = new MessageRouter(store, this.conns, this.sessions, this.updateRequests, this.tasks);
  }

  // ---------- connections ----------

  registerConnection(
    userId: string,
    send: (msg: ServerMessage) => void,
    close?: () => void,
  ): () => void {
    return this.conns.registerConnection(userId, send, close);
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
    name: string,
    agentId: string,
    visibility: "personal" | "public" = "personal",
    description?: string,
  ) {
    return this.registry.createProject(userId, name, agentId, visibility, description);
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
    return this.registry.deleteProjectRecord(projectId)
      ? { ok: true }
      : { ok: false, code: "not_found" };
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
    return this.registry.setShared(userId, sessionId, shared, sharedWith, approvers);
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
    return this.registry.renameSession(userId, sessionId, title);
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

  /** Stop the current run without closing the session (used on interrupt). */
  markIdleAfterInterrupt(sessionId: string): void {
    // The consume loop's finally block handles idle scheduling; nothing extra needed.
  }
}
