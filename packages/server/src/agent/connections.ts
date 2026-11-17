import type { ServerMessage } from "@blm/protocol";
import { Store, sharedWithUser } from "../store.js";

// Who is connected over WS, and which server messages each connection receives.

export type SendFn = (msg: ServerMessage) => void;

interface Conn {
  send: SendFn;
  /** Forces the underlying socket closed (used to kick disabled accounts). */
  close?: () => void;
  /** "mobile" = 手机壳连接（无本机执行能力）：执行请求优先派给
   * 同账号的桌面连接，仅当桌面全不在线时才落到手机。 */
  kind?: "mobile";
}

export class ConnectionRegistry {
  private store: Store;
  private byUser = new Map<string, Set<Conn>>();

  /**
   * 会话 → 当前负责人（工作台跟随指派）。由 AgentManager 在 TaskManager
   * 构造完成后注入（两者互需引用，晚绑定避免循环构造）；无任务返回 null，
   * 路由回退会话主人。
   */
  execTargetResolver: ((sessionId: string) => string | null) | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  registerConnection(userId: string, send: SendFn, close?: () => void, kind?: "mobile"): () => void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    const conn: Conn = { send, close, kind };
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

  /**
   * Send to every connection of one user. prefer="desktop" 时跳过
   * mobile 连接（同账号手机+桌面都在线，本机执行不该落到手机）；
   * 仅当该用户只有 mobile 连接时才照发。
   */
  broadcast(userId: string, msg: ServerMessage, prefer?: "desktop"): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const conn of set) {
      if (prefer === "desktop" && conn.kind === "mobile" && set.size > 1) {
        // 同账号还有其他（桌面）连接：mobile 不接执行请求。
        // set.size===1 时（只有手机在线）照发，让手机得到
        // 明确的拒绝回执而不是引擎侧超时。
        continue;
      }
      conn.send(msg);
    }
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
   * is shared. Local execution (tool_exec_request) goes to the session's
   * current executor (工作台跟随指派)，无任务的共享会话钉死会话主人
   * （使用方只是借用宿主的能力与信息，操作不落到自己机器上）。
   * Permission requests additionally reach the online executor and online
   * approvers (approvers 字段，须同时是共享可见用户)：谁先应答谁生效。
   */
  broadcastShared(ownerId: string, sessionId: string, msg: ServerMessage): void {
    if (msg.type === "tool_exec_request") {
      const target = this.execTargetResolver?.(sessionId) ?? ownerId;
      this.broadcast(target, msg, "desktop");
      return;
    }
    this.broadcast(ownerId, msg);
    const rec = this.store.getSession(sessionId);
    if (msg.type === "permission_request") {
      const executor = this.execTargetResolver?.(sessionId);
      if (executor && executor !== ownerId && this.isOnline(executor)) {
        this.broadcast(executor, msg);
      }
      if (!rec?.shared) return;
      for (const uid of rec.approvers ?? []) {
        if (
          uid === ownerId ||
          uid === executor ||
          !sharedWithUser(rec, uid) ||
          !this.isOnline(uid)
        ) {
          continue;
        }
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
