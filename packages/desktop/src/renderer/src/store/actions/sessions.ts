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
  | "fetchSessionHistory"
  | "refreshOpenSessions"
  | "setSessionShare"
  | "listUsers"
  | "loadShared"
  | "ownerOnlineOf"
  | "deleteSession"
  | "closeTab"
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
        openTabs: s.openTabs.includes(session.session_id)
          ? s.openTabs
          : [...s.openTabs, session.session_id],
        blocksBySession: { ...s.blocksBySession, [session.session_id]: [] },
        streaming: { ...s.streaming, [session.session_id]: "" },
        busy: { ...s.busy, [session.session_id]: false },
        currentAgentId: agentId,
      }));
      localStorage.setItem(LS.agentId, agentId);
      // Tell the main process which folder confines this session's local ops.
      void window.blm.setSessionProject(session.session_id, session.project_id ?? null);
      get().setBrowserActiveSession(session.session_id);
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
      // 点过的会话进 tab（已开则原位保留，不抢焦点顺序）。
      const openTabs = get().openTabs.includes(id)
        ? get().openTabs
        : [...get().openTabs, id];
      const firstOpen = !get().blocksBySession[id];
      // 先切焦点并立即用已有缓存渲染（tab 再点开是秒切，不转圈）；
      // 首次打开才拉全量历史。
      set((s) => ({
        currentSessionId: id,
        sharedView: false,
        openTabs,
        ...(firstOpen
          ? {}
          : { streaming: { ...s.streaming, [id]: "" } }),
      }));
      // WS 在流式接收的会话：本地缓存持续是最新的，无需重拉；
      // 非当前会话的历史也可能因对方发言/共享视图更新而落后，
      // 但 tab 重开走的是增量推送，只有首次打开需要兜底全量。
      // 断线窗口错过的消息由重连后的 refreshOpenSessions 兜底。
      if (firstOpen) void get().fetchSessionHistory(id);
      const session = get().sessions.find((x) => x.session_id === id);
      void window.blm.setSessionProject(id, session?.project_id ?? null);
      // 内置浏览器跟随 tab 焦点：显示本会话的页面（或收起）。
      get().setBrowserActiveSession(id);
    },

    /** 拉取一个会话的全量历史替换本地缓存（服务端为权威）。失败保留现有
     *  缓存并报错——绝不静默清空（token 失效时显示一片空白比报错更糟）。 */
    async fetchSessionHistory(id) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/sessions/${id}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          set({ error: t("err.historyLoadFail") });
          return;
        }
        const blocks = ((await res.json()) as { blocks: Block[] }).blocks;
        set((s) => ({ blocksBySession: { ...s.blocksBySession, [id]: blocks } }));
      } catch {
        set({ error: t("err.historyLoadFail") });
      }
    },

    /** 重连后补齐断线窗口里的消息：服务端对聊天只推不回放，错过只能重拉。
     *  覆盖全部已打开会话（含共享视图——不走 selectSession，避免退出 sharedView）。 */
    async refreshOpenSessions() {
      const ids = new Set(get().openTabs);
      const cur = get().currentSessionId;
      if (cur) ids.add(cur);
      await Promise.all([...ids].map((id) => get().fetchSessionHistory(id)));
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
        const openTabs = s.openTabs.filter((x) => x !== id);
        const fallback = openTabs.find((x) => x !== id) ?? sessions[0]?.session_id ?? null;
        return {
          sessions,
          openTabs,
          attachments: { ...s.attachments, [id]: [] },
          currentSessionId: currentSessionId === id ? fallback : currentSessionId,
          sharedView: currentSessionId === id ? false : s.sharedView,
        };
      });
      // 浏览器页面按会话存：会话删除（或焦点落到别的 tab）时，
      // 通知主进程按新焦点显示/收起页面。
      const next = get().currentSessionId;
      get().setBrowserActiveSession(next);
    },

    /** 关一个会话 tab（会话保留；关当前 tab 落到相邻 tab）。 */
    closeTab(id) {
      const { currentSessionId } = get();
      set((s) => {
        const idx = s.openTabs.indexOf(id);
        if (idx === -1) return {};
        const openTabs = s.openTabs.filter((x) => x !== id);
        // 只在关的是当前 tab 时才换焦点；落在相邻 tab（先右后左）。
        if (id !== currentSessionId) return { openTabs };
        const next =
          openTabs[Math.min(idx, openTabs.length - 1)] ?? null;
        return {
          openTabs,
          currentSessionId: next,
          sharedView: false,
          // 换焦点即换会话上下文：朗读/表情归位。
        };
      });
      if (id === currentSessionId) {
        get().stopSpeaking();
        get().setExpr("normal");
        const next = get().currentSessionId;
        if (next) void get().selectSession(next);
        // 焦点移走（或没有 tab 了）：浏览器显示新 tab 的页面/收起。
        get().setBrowserActiveSession(get().currentSessionId);
      }
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
