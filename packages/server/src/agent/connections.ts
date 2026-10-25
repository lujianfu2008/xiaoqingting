import type { ServerMessage } from "@blm/protocol";
import { Store, sharedWithUser } from "../store.js";

// Who is connected over WS, and which server messages each connection receives.

// Interactive confirmations must only reach the owner (only the owner can
// approve local actions on their machine).
const OWNER_ONLY_MSGS = new Set(["permission_request", "tool_exec_request"]);

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
   * is shared. Interactive confirmations (permission/exec popups) always stay
   * owner-only: only the owner can approve actions on their own machine.
   */
  broadcastShared(ownerId: string, sessionId: string, msg: ServerMessage): void {
    if (OWNER_ONLY_MSGS.has(msg.type)) {
      this.broadcast(ownerId, msg);
      return;
    }
    this.broadcast(ownerId, msg);
    const rec = this.store.getSession(sessionId);
    if (!rec?.shared) return;
    for (const [uid, set] of this.byUser) {
      if (uid === ownerId || !sharedWithUser(rec, uid)) continue;
      for (const conn of set) conn.send(msg);
    }
  }
}
