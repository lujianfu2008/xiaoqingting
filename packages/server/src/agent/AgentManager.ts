import type { AttachmentImage, ServerMessage, UpdateRequestStatus, UpdateRequestView } from "@blm/protocol";
import { Store, type SessionRecord, type TaskRecord } from "../store.js";
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
    // 工作台跟随指派：本机执行/审批的目标由任务当前负责人决定（晚绑定防循环构造）。
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

  // ---------- projects ----------

  createProject(
    userId: string,
    name: string,
    agentId: string,
    visibility: "personal" | "public" = "personal",
  ) {
    return this.registry.createProject(userId, name, agentId, visibility);
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
  ): { ok: true } | { ok: false; code: "not_found" | "task_active" } {
    // Stop the live engine first so it cannot append to a record being removed.
    if (!this.registry.isOwner(userId, sessionId)) return { ok: false, code: "not_found" };
    // 协作流任务线程守卫：任务未完结不可删（防撕掉时间线与共享视图）；
    // done 后可删，任务记录保留（客户端列表降级灰显）。
    const rec = this.store.getSession(sessionId);
    if (rec?.task_id) {
      const task = this.tasks.getTask(rec.task_id);
      if (task && task.status !== "done") return { ok: false, code: "task_active" };
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

  /** WS 连接建立补推：未完结任务。 */
  activeTasksFor(userId: string): TaskRecord[] {
    return this.tasks.activeFor(userId);
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

  handleUserMessage(userId: string, sessionId: string, text: string): void {
    this.router.handleUserMessage(userId, sessionId, text);
  }

  handleInterrupt(userId: string, sessionId: string): void {
    this.router.handleInterrupt(userId, sessionId);
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
