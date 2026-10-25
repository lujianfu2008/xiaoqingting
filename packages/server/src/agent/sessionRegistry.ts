import { Store, type ProjectRecord, type SessionRecord, sharedWithUser } from "../store.js";
import { isPublicAdmin } from "../users.js";

// Session CRUD, sharing and history reads, always scoped to the acting user.

export class SessionRegistry {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 个人项目仅本人可用；公有域项目全员可用（会话仍归属创建者本人）。 */
  private canUseProject(userId: string, proj: ProjectRecord | null): boolean {
    if (!proj) return false;
    return proj.user_id === userId || proj.visibility === "public";
  }

  createSession(
    userId: string,
    agentId: string,
    title?: string,
    projectId?: string | null,
  ): SessionRecord | null {
    // A session can only be attached to a project owned by the same user, or to any public project.
    if (projectId) {
      const proj = this.store.getProject(projectId);
      if (!this.canUseProject(userId, proj)) return null;
    }
    return this.store.createSession(userId, agentId, title?.trim() || "新对话", projectId ?? null);
  }

  // ---------- projects ----------

  createProject(userId: string, name: string, agentId: string, visibility: "personal" | "public" = "personal") {
    return this.store.createProject(userId, name, agentId, visibility);
  }

  listProjects(userId: string) {
    return this.store.listProjects(userId);
  }

  /** 个人项目仅本人可管理（删除）；公有域项目任何公有域管理员可管理。 */
  canManageProject(userId: string, proj: ProjectRecord): boolean {
    if (proj.visibility === "public") return isPublicAdmin(userId);
    return proj.user_id === userId;
  }

  /** Delete a project record (access pre-checked via canManageProject); its sessions fall back to the default space. */
  deleteProjectRecord(projectId: string): boolean {
    if (!this.store.getProject(projectId)) return false;
    this.store.deleteProject(projectId);
    return true;
  }

  listSessions(userId: string) {
    return this.store.listSessions(userId);
  }

  /** Sessions other users shared (read-only knowledge sharing). */
  listSharedSessions(userId: string, isOnline: (userId: string) => boolean) {
    return this.store
      .listSharedSessions(userId)
      .map((s) => ({ ...s, owner_online: isOnline(s.owner ?? "") }));
  }

  /** Toggle sharing on the user's own session. Returns false if not owner. */
  setShared(
    userId: string,
    sessionId: string,
    shared: boolean,
    sharedWith?: string[],
  ): SessionRecord | null {
    const rec = this.store.getSession(sessionId);
    if (!rec || rec.user_id !== userId) return null;
    rec.shared = shared;
    if (shared) rec.shared_with = sharedWith ?? [];
    else delete rec.shared_with;
    this.store.saveSession(rec);
    return rec;
  }

  isOwner(userId: string, sessionId: string): boolean {
    const rec = this.store.getSession(sessionId);
    return !!rec && rec.user_id === userId;
  }

  /** Move the user's own session into one of their projects (null = 默认空间).
   *  History and agent role stay; only the grouping changes. 个人↔公域之间
   *  禁止移动（两者的工具集不同，引擎 loop 在途时无法切换）。 */
  moveSession(
    userId: string,
    sessionId: string,
    projectId: string | null,
  ): { ok: true; rec: SessionRecord } | { ok: false; code: "not_found" | "cross_visibility" } {
    const rec = this.store.getSession(sessionId);
    if (!rec || rec.user_id !== userId) return { ok: false, code: "not_found" };
    if (projectId) {
      const proj = this.store.getProject(projectId);
      if (!proj || !this.canUseProject(userId, proj)) return { ok: false, code: "not_found" };
    }
    // 跨 visibility 一律拒绝（默认空间视为个人域；公域会话移回默认空间同样拦截）。
    const from = rec.project_id ? this.store.getProject(rec.project_id) : null;
    const targetPublic = projectId
      ? this.store.getProject(projectId)?.visibility === "public"
      : false;
    if ((from?.visibility === "public") !== targetPublic) {
      return { ok: false, code: "cross_visibility" };
    }
    rec.project_id = projectId;
    this.store.saveSession(rec);
    return { ok: true, rec };
  }

  deleteSession(userId: string, sessionId: string): boolean {
    if (!this.isOwner(userId, sessionId)) return false;
    this.store.deleteSession(sessionId);
    return true;
  }

  getHistory(userId: string, sessionId: string) {
    const rec = this.store.getSession(sessionId);
    // Owner has full access; other users only sessions shared with them.
    if (!rec || (rec.user_id !== userId && !(rec.shared && sharedWithUser(rec, userId)))) {
      return null;
    }
    return {
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
      blocks: this.store.getHistory(sessionId),
    };
  }
}
