import type { AttachmentImage } from "@blm/protocol";
import { Store, sharedWithUser } from "../store.js";
import { AgentSession } from "./AgentSession.js";
import type { ConnectionRegistry } from "./connections.js";
import type { UpdateRequestManager } from "./updateRequests.js";

// WS message routing: chat turns, interrupts, permission answers and local
// execution results, each gated by session ownership/sharing.

export class MessageRouter {
  private store: Store;
  private conns: ConnectionRegistry;
  private sessions: Map<string, AgentSession>;

  constructor(
    store: Store,
    conns: ConnectionRegistry,
    sessions: Map<string, AgentSession>,
    private updateRequests: UpdateRequestManager,
  ) {
    this.store = store;
    this.conns = conns;
    this.sessions = sessions;
  }

  /** Handle a user chat message over WS. Lazily (re)starts the session loop, resuming engine state. */
  handleUserMessage(userId: string, sessionId: string, text: string): void {
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

    // Collaborators cannot make progress without the owner: tool approvals and
    // local execution requests are owner-only, so fail fast instead of letting
    // the engine stall on a 120s client-exec timeout.
    if (rec.user_id !== userId && !this.conns.isOnline(rec.user_id)) {
      this.conns.broadcast(userId, {
        type: "error",
        session_id: sessionId,
        code: "owner_offline",
        message: "会话主人当前不在线，暂时无法发言，请稍后再试。",
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
          owner: rec.user_id,
        },
      });
    }
    rec.updated_at = new Date().toISOString();
    this.store.saveSession(rec);
    const userBlock = { kind: "user_text", text } as const;
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
      session = new AgentSession(
        rec,
        this.store,
        {
          send: (msg) => this.conns.broadcastShared(rec.user_id, sessionId, msg),
          isOwnerOnline: () => this.conns.isOnline(rec.user_id),
        },
        this.updateRequests,
      );
      this.sessions.set(sessionId, session);
    }
    session.sendUserMessage(text);
  }

  handleInterrupt(userId: string, sessionId: string): void {
    const rec = this.store.getSession(sessionId);
    if (!rec || rec.user_id !== userId) return;
    void this.sessions.get(sessionId)?.interrupt();
  }

  handlePermissionResponse(userId: string, requestId: string, allow: boolean): void {
    const sid = requestId.split(":")[0];
    const rec = sid ? this.store.getSession(sid) : null;
    if (!rec || rec.user_id !== userId) return;
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
    if (!rec || rec.user_id !== userId) return;
    this.sessions.get(sid)?.respondExec(requestId, result);
  }
}
