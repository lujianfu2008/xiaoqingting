import type { Block, SessionMeta, UserSummary } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { LS } from "../persist";
import { t } from "../../i18n";

export function createSessionActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "newSession"
  | "loadSessions"
  | "selectSession"
  | "selectSharedSession"
  | "setSessionShare"
  | "listUsers"
  | "loadShared"
  | "ownerOnlineOf"
  | "deleteSession"
  | "moveSession"
  | "renameSession"
  | "setCurrentAgent"
> {
  return {
    async newSession(agentId, projectId) {
      // 切入新会话：停掉上一会话的朗读，表情归位。
      get().stopSpeaking();
      get().setExpr("normal");
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_id: agentId, ...(projectId ? { project_id: projectId } : {}) }),
      });
      if (!res.ok) return;
      const session = (await res.json()) as SessionMeta;
      set((s) => ({
        sessions: [session, ...s.sessions],
        currentSessionId: session.session_id,
        blocksBySession: { ...s.blocksBySession, [session.session_id]: [] },
        streaming: { ...s.streaming, [session.session_id]: "" },
        busy: { ...s.busy, [session.session_id]: false },
        currentAgentId: agentId,
      }));
      localStorage.setItem(LS.agentId, agentId);
      // Tell the main process which folder confines this session's local ops.
      void window.blm.setSessionProject(session.session_id, session.project_id ?? null);
    },

    async loadSessions() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const sessions = (await res.json()) as SessionMeta[];
        set({ sessions });
        // Sync the whole session->project map (covers sessions created on
        // another machine or before this desktop last ran).
        for (const s of sessions) {
          void window.blm.setSessionProject(s.session_id, s.project_id ?? null);
        }
      } catch {
        // offline — keep the last list
      }
    },

    async selectSession(id) {
      // 真正切换会话（而非重连时对同一会话补拉）：停掉朗读、表情归位，
      // 状态同步到新会话，不把上一个会话的朗读/表情带过去。
      if (get().currentSessionId && get().currentSessionId !== id) {
        get().stopSpeaking();
        get().setExpr("normal");
      }
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const blocks = res.ok ? ((await res.json()) as { blocks: Block[] }).blocks : [];
      set((s) => ({
        currentSessionId: id,
        sharedView: false,
        blocksBySession: { ...s.blocksBySession, [id]: blocks },
        streaming: { ...s.streaming, [id]: "" },
      }));
      const session = get().sessions.find((x) => x.session_id === id);
      void window.blm.setSessionProject(id, session?.project_id ?? null);
    },

    /** View a session shared by another user (read-only). */
    async selectSharedSession(id) {
      await get().selectSession(id);
      set({ sharedView: true });
    },

    async setSessionShare(id, shared, sharedWith, approvers) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(
          shared
            ? { shared, shared_with: sharedWith ?? [], approvers: approvers ?? [] }
            : { shared },
        ),
      });
      if (!res.ok) return;
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.session_id === id
            ? {
                ...x,
                shared,
                shared_with: shared ? (sharedWith ?? []) : [],
                approvers: shared && approvers && approvers.length > 0 ? approvers : [],
              }
            : x,
        ),
      }));
    },

    async listUsers() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { users: UserSummary[] };
        return data.users;
      } catch {
        return [];
      }
    },

    /** Whether the owner of the shared session currently viewed is online. */
    ownerOnlineOf(sessionId) {
      const { sharedSessions, presence } = get();
      const s = sharedSessions.find((x) => x.session_id === sessionId);
      if (!s?.owner) return true; // own session — always allowed
      return presence[s.owner] ?? s.owner_online ?? false;
    },

    async loadShared() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/shared`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const sharedSessions = (await res.json()) as SessionMeta[];
        set({ sharedSessions });
      } catch {
        // offline — keep the last list
      }
    },

    async deleteSession(id) {
      const { serverUrl, token, currentSessionId } = get();
      // 删掉的是当前会话：同样停朗读、表情归位（即将切换到别的会话）。
      if (currentSessionId === id) {
        get().stopSpeaking();
        get().setExpr("normal");
      }
      const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      // 服务端拒绝（如协作任务线程守卫）：保留会话并提示——别造成「看似删掉、
      // 刷新又回来」。404 = 服务端本就没有，照常清本地。
      if (!res.ok && res.status !== 404) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        set({ error: body.message || t("task.deleteBlocked") });
        return;
      }
      void window.blm.forgetSession(id);
      set((s) => {
        const sessions = s.sessions.filter((x) => x.session_id !== id);
        return {
          sessions,
          currentSessionId:
            currentSessionId === id ? (sessions[0]?.session_id ?? null) : currentSessionId,
          sharedView: currentSessionId === id ? false : s.sharedView,
        };
      });
    },

    async moveSession(id, projectId) {
      const { serverUrl, token } = get();
      const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (body.error === "cross_visibility") set({ error: t("move.crossVisibility") });
        }
        return;
      }
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.session_id === id ? { ...x, project_id: projectId } : x,
        ),
      }));
      // The work dir (and read scope) follows the session's project.
      void window.blm.setSessionProject(id, projectId);
    },

    async renameSession(id, title) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title }),
        });
        if (!res.ok) {
          set({ error: t("sess.renameFail") });
          return false;
        }
        set((s) => ({
          sessions: s.sessions.map((x) => (x.session_id === id ? { ...x, title } : x)),
        }));
        return true;
      } catch {
        return false;
      }
    },

    setCurrentAgent(agentId) {
      set({ currentAgentId: agentId });
      localStorage.setItem(LS.agentId, agentId);
    },
  };
}
