import type { AttachmentImage } from "@blm/protocol";
import { Store, sharedWithUser } from "../store.js";
import { AgentSession } from "./AgentSession.js";
import type { ConnectionRegistry } from "./connections.js";
import type { TaskManager } from "./taskManager.js";
import type { UpdateRequestManager } from "./updateRequests.js";

// WS message routing: chat turns, interrupts, permission answers and local
// execution results, each gated by session ownership/sharing. 协作流任务线程
// 的执行面（发言守卫/审批/本机执行/中断）跟随当前负责人（工作台跟随指派）。

export class MessageRouter {
  private store: Store;
  private conns: ConnectionRegistry;
  private sessions: Map<string, AgentSession>;
  /** sessionId → 最近一条用户消息的发送者。普通共享会话的本机执行跟随发言
   *  人（谁在驱动会话，工具就落在谁的机器上），避免窗口突然弹到没在看这个
   *  会话的主人桌上。内存态：重启后回退主人，下一条消息重新跟随。 */
  private lastSpeaker = new Map<string, string>();

  constructor(
    store: Store,
    conns: ConnectionRegistry,
    sessions: Map<string, AgentSession>,
    private updateRequests: UpdateRequestManager,
    private tasks: TaskManager,
  ) {
    this.store = store;
    this.conns = conns;
    this.sessions = sessions;
  }

  /** 当前负责人（无任务回退主人）；协作线程执行面的目标用户。 */
  private executorOf(sessionId: string, rec: { user_id: string }): string {
    return this.tasks.executorOf(sessionId) ?? rec.user_id;
  }

  /** 最近发言人（无记录为 null，调用方回退主人）。 */
  lastSpeakerOf(sessionId: string): string | null {
    return this.lastSpeaker.get(sessionId) ?? null;
  }

  /** 本机执行（tool_exec_request）的目标用户：协作任务会话跟随当前负责人
   *  （工作台跟随指派）；普通会话跟随最近发言人；再退回会话主人。 */
  private execTargetOf(sessionId: string, rec: { user_id: string }): string {
    return this.tasks.executorOf(sessionId) ?? this.lastSpeakerOf(sessionId) ?? rec.user_id;
  }

  /** Handle a user chat message over WS. Lazily (re)starts the session loop, resuming engine state. */
  handleUserMessage(userId: string, sessionId: string, text: string, clientMsgId?: string): void {
    const rec = this.store.getSession(sessionId);
    // The owner can always chat; other users only in sessions shared with them.
    if (!rec || (rec.user_id !== userId && !(rec.shared && sharedWithUser(rec, userId)))) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "session_not_found",
        message: "会话不存在或无权访问。",
      });
      return;
    }

    // 协作者要推进线程，得有人能应答审批/本机执行——即当前负责人。负责人
    // 不在线时快速失败（owner 与负责人本人始终可发言），避免引擎卡在本机
    // 执行超时上。
    const executor = this.executorOf(sessionId, rec);
    if (
      rec.user_id !== userId &&
      userId !== executor &&
      !this.conns.isOnline(executor)
    ) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "executor_offline",
        message:
          executor === rec.user_id
            ? "会话主人当前不在线，暂时无法发言，请稍后再试。"
            : "当前负责人不在线，暂时无法发言，请稍后再试。",
      });
      return;
    }

    // First user message becomes the session title.
    if (rec.title === "新对话") {
      rec.title = text.slice(0, 40);
      rec.updated_at = new Date().toISOString();
      this.store.saveSession(rec);
      this.conns.broadcastShared(rec.user_id, sessionId, {
        type: "session_created",
        session: {
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
        },
      });
    }
    rec.updated_at = new Date().toISOString();
    this.store.saveSession(rec);
    // 记录驱动者：本会话的本机执行（含内置浏览器）落到这台机器上。
    this.lastSpeaker.set(sessionId, userId);
    const userBlock = {
      kind: "user_text",
      text,
      ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
    } as const;
    this.store.appendBlocks(sessionId, [userBlock]);
    // Echo the message to the owner and (if shared) every connected user, so
    // collaborators see each other's messages live. The sender's client skips
    // its local echo when this arrives.
    this.conns.broadcastShared(rec.user_id, sessionId, {
      type: "message_block",
      session_id: sessionId,
      block: userBlock,
    });

    let session = this.sessions.get(sessionId);
    if (!session) {
      const created = new AgentSession(
        rec,
        this.store,
        {
          send: (msg) => this.conns.broadcastShared(rec.user_id, sessionId, msg),
          // 本机执行的 fail-fast 判的是执行目标在线状态（任务负责人或最近发
          // 言人，随指派/发言动态变化，故每次调用现查）。
          isExecutorOnline: () =>
            this.conns.isOnline(this.execTargetOf(sessionId, rec)),
          // 空闲回收/引擎退出时把会话从 Map 摘除：下一条消息走新建 + resume，
          // 而不是把消息推进死队列被静默吞掉。
          onDispose: () => {
            if (this.sessions.get(sessionId) === created) this.sessions.delete(sessionId);
            this.lastSpeaker.delete(sessionId);
          },
        },
        this.updateRequests,
      );
      session = created;
      this.sessions.set(sessionId, created);
    }
    session.sendUserMessage(text);
  }

  handleInterrupt(userId: string, sessionId: string): void {
    const rec = this.store.getSession(sessionId);
    // 主人或当前负责人可中断引擎（负责人在自己的工作台上驱动 agent，要能停）。
    const executor = rec ? this.executorOf(sessionId, rec) : null;
    if (!rec || (rec.user_id !== userId && userId !== executor)) return;
    void this.sessions.get(sessionId)?.interrupt();
  }

  handlePermissionResponse(userId: string, requestId: string, allow: boolean): void {
    const sid = requestId.split(":")[0];
    const rec = sid ? this.store.getSession(sid) : null;
    if (!rec) return;
    // 可应答者：主人、被授权的审批人（approvers，且须共享可见）、当前负责人
    // （工作台跟随指派）。先到先结算，后到的应答在 PendingMap 上是 no-op。
    const isApprover =
      rec.user_id !== userId &&
      (rec.approvers ?? []).includes(userId) &&
      rec.shared &&
      sharedWithUser(rec, userId);
    const isExecutor = this.executorOf(sid, rec) === userId;
    if (rec.user_id !== userId && !isApprover && !isExecutor) return;
    this.sessions.get(sid)?.respondPermission(requestId, allow);
  }

  /** Route a client's local-execution result back to the waiting session. */
  handleToolExecResult(
    userId: string,
    requestId: string,
    result: { ok: boolean; output?: string; error?: string; images?: AttachmentImage[] },
  ): void {
    const sid = requestId.split(":")[0];
    const rec = sid ? this.store.getSession(sid) : null;
    if (!rec) return;
    // 结果来自当前执行目标（任务负责人或最近发言人）的客户端；主人的应答也
    // 接受——防流转瞬间的边界下（请求发给旧目标、应答迟到）结果被静默丢弃。
    const target = this.execTargetOf(sid, rec);
    if (rec.user_id !== userId && userId !== target) return;
    this.sessions.get(sid)?.respondExec(requestId, result);
  }
}
