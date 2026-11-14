import type { AttachmentImage } from "@blm/protocol";
import { Store, sharedWithUser, type SessionRecord } from "../store.js";
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
  /** sessionId → 最近一条用户消息的发送者。**仅用于中断权**：
   *  普通共享会话里提问的协作者能停掉自己发起的回合。执行面
   *  （本机执行）不跟随发言人——共享会话一律钉死会话主人，使用方
   *  只是借用宿主的能力与信息，不能把文件/命令操作引到自己机器上。 */
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

  /** 当前负责人（无任务回退主人）。执行面（本机执行/审批/快速失败）
   *  的目标用户：协作任务会话跟随任务当前负责人（工作台跟随指派）；
   *  共享会话一律钉死会话主人——使用方只是借用宿主的能力与信息，
   *  绝不能让宿主的会话把文件/命令操作落到自己的机器、污染自己的
   *  工作目录。 */
  private executorOf(sessionId: string, rec: { user_id: string }): string {
    return this.tasks.executorOf(sessionId) ?? rec.user_id;
  }

  /** 最近发言人（无记录为 null）。只用于中断权，不用于执行面。 */
  lastSpeakerOf(sessionId: string): string | null {
    return this.lastSpeaker.get(sessionId) ?? null;
  }

  /** 访问守卫（主人恒可发言；其他成员仅共享会话可发言）。 */
  private checkAccess(
    userId: string,
    sessionId: string,
  ): SessionRecord | null {
    const rec = this.store.getSession(sessionId);
    // The owner can always chat; other users only in sessions shared with them.
    if (!rec || (rec.user_id !== userId && !(rec.shared && sharedWithUser(rec, userId)))) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "session_not_found",
        message: "会话不存在或无权访问。",
      });
      return null;
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
      return null;
    }
    return rec;
  }

  /** 记录驱动者：**仅中断权**——普通共享会话里提问的协作者能停掉
   *  自己发起的回合（执行面不跟随此记录，见 executorOf）。 */
  private recordSpeaker(rec: SessionRecord, userId: string, sessionId: string): void {
    this.lastSpeaker.set(sessionId, userId);
  }

  /** Handle a user chat message over WS. Lazily (re)starts the session loop, resuming engine state. */
  handleUserMessage(userId: string, sessionId: string, text: string, clientMsgId?: string): void {
    const rec = this.checkAccess(userId, sessionId);
    if (!rec) return;

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
    // 记录驱动者（仅中断权）：本会话的回合可被此用户中断。
    this.recordSpeaker(rec, userId, sessionId);
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

    this.sessionOf(rec, sessionId).sendUserMessage(text);
  }

  /** 重新生成：对最后一条用户消息再跑一轮回复。 */
  handleRegenerate(userId: string, sessionId: string): void {
    const rec = this.checkAccess(userId, sessionId);
    if (!rec) return;
    // 原文取自已落库历史：不追加新 user_text 块（聊天记录不重复），
    // 引擎按既有上下文对同一提问重新作答。
    const lastUser = this.lastUserText(sessionId);
    if (lastUser === null) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "session_not_found",
        message: "会话还没有可重新回答的消息。",
      });
      return;
    }
    this.store.saveSession(rec);
    // 记录驱动者（仅中断权）。
    this.recordSpeaker(rec, userId, sessionId);
    const session = this.sessionOf(rec, sessionId);
    session.sendUserMessage(lastUser);
  }

  /** 最后一条用户消息原文（剥离附件行）；还没有用户消息时为 null。 */
  private lastUserText(sessionId: string): string | null {
    const blocks = this.store.getHistory(sessionId);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind !== "user_text") continue;
      // [附件] 行是发送时的传输编码（文件路径），重新生成时剥掉。
      const text = b.text
        .split("\n")
        .filter((l) => !/^\[附件\]\s*.+→/.test(l))
        .join("\n")
        .trim();
      return text.length > 0 ? text : null;
    }
    return null;
  }

  /** Lazily (re)start the session loop, resuming engine state. */
  private sessionOf(rec: SessionRecord, sessionId: string): AgentSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const created = new AgentSession(
        rec,
        this.store,
        {
          send: (msg) => this.conns.broadcastShared(rec.user_id, sessionId, msg),
          // 本机执行的 fail-fast 判的是执行目标在线状态（任务负责人
          // 或会话主人，随指派动态变化，故每次调用现查）。
          isExecutorOnline: () =>
            this.conns.isOnline(this.executorOf(sessionId, rec)),
          // 空闲回收/引擎退出时把会话从 Map 摘除：下一条消息走新建 + resume，
          // 而不是把消息推进死队列被静默吞掉。中断权记录一并清掉
          // （会话重开后由下一条消息重新记录）。
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
    return session;
  }

  handleInterrupt(userId: string, sessionId: string): void {
    const rec = this.store.getSession(sessionId);
    if (!rec) return;
    // 可中断者：主人、任务当前负责人（工作台跟随指派，本机执行落
    // 在谁头上谁就要能停），以及最近发言人——普通共享会话里提问的
    // 协作者由此能停掉自己发起的回合（中断权独立于执行面）。
    const target = this.executorOf(sessionId, rec);
    const speaker = this.lastSpeakerOf(sessionId);
    if (rec.user_id !== userId && userId !== target && userId !== speaker) {
      // 明确反馈而非静默丢弃。session_id 置 null：带 session_id 的
      // error 会把客户端该会话的 busy 复位，而回合还在跑。
      if (rec.shared && sharedWithUser(rec, userId)) {
        this.conns.broadcast(userId, {
          type: "error",
          session_id: null,
          code: "interrupt_denied",
          message: "只有会话主人或当前驱动者可以停止本次回答。",
        });
      }
      return;
    }
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
    // 结果来自当前执行目标（任务负责人，否则会话主人）的客户端；主人
    // 以外的应答按目标比对——防流转瞬间的边界下（请求发给旧目标、
    // 应答迟到）结果被静默丢弃。
    const target = this.executorOf(sid, rec);
    if (rec.user_id !== userId && userId !== target) return;
    this.sessions.get(sid)?.respondExec(requestId, result);
  }
}
