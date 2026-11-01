import type { ServerMessage } from "@blm/protocol";
import { Store, sharedWithUser } from "../store.js";

// Who is connected over WS, and which server messages each connection receives.

export type SendFn = (msg: ServerMessage) => void;

interface Conn {
  send: SendFn;
  /** Forces the underlying socket closed (used to kick disabled accounts). */
  close?: () => void;
}

export class ConnectionRegistry {
  private store: Store;
  private byUser = new Map<string, Set<Conn>>();

  constructor(store: Store) {
    this.store = store;
  }

  registerConnection(userId: string, send: SendFn, close?: () => void): () => void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    const conn: Conn = { send, close };
    set.add(conn);
    if (wasEmpty) {
      this.broadcastAll({ type: "presence", user_id: userId, online: true });
    }
    return () => {
      const s = set!;
      s.delete(conn);
      if (s.size === 0) {
        this.byUser.delete(userId);
        this.broadcastAll({ type: "presence", user_id: userId, online: false });
      }
    };
  }

  /** Whether the user currently has at least one live WS connection. */
  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  broadcastAll(msg: ServerMessage): void {
    for (const set of this.byUser.values()) {
      for (const conn of set) conn.send(msg);
    }
  }

  /** Send to every connection of one user. */
  broadcast(userId: string, msg: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const conn of set) conn.send(msg);
  }

  /**
   * Force-drop every connection of one user (account disabled): notify first,
   * then close the sockets. The unregister callbacks still run afterwards and
   * are harmless no-ops.
   */
  dropUser(userId: string, msg: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const conn of set) {
      conn.send(msg);
      conn.close?.();
    }
  }

  /**
   * Broadcast to the owner, plus every other connected user while the session
   * is shared. Local execution (tool_exec_request) stays owner-only — it runs
   * on the owner's machine. Permission requests additionally reach online
   * approvers (approvers 字段，须同时是共享可见用户)：谁先应答谁生效。
   */
  broadcastShared(ownerId: string, sessionId: string, msg: ServerMessage): void {
    if (msg.type === "tool_exec_request") {
      this.broadcast(ownerId, msg);
      return;
    }
    this.broadcast(ownerId, msg);
    const rec = this.store.getSession(sessionId);
    if (msg.type === "permission_request") {
      if (!rec?.shared) return;
      for (const uid of rec.approvers ?? []) {
        if (uid === ownerId || !sharedWithUser(rec, uid) || !this.isOnline(uid)) continue;
        this.broadcast(uid, msg);
      }
      return;
    }
    if (!rec?.shared) return;
    for (const [uid, set] of this.byUser) {
      if (uid === ownerId || !sharedWithUser(rec, uid)) continue;
      for (const conn of set) conn.send(msg);
    }
  }
}
