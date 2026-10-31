import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { clearIdentity, LS, saveIdentity } from "../persist";
import {
  currentSocket,
  resetReconnect,
  resetReconnectAttempt,
  setClosedByUser,
  setSocket,
} from "../socket";
import { t } from "../../i18n";

interface AuthResponse {
  token: string;
  username: string;
  employee_id: string;
  role: "admin" | "reviewer" | "user";
}

interface RegisterResponseData {
  username: string;
  employee_id: string;
  status: "pending" | "approved" | "rejected";
  // 仅 status === "approved" 时服务端才会带（新注册一律 pending，不会带）。
  token?: string;
}

export function createAuthActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "login"
  | "register"
  | "dismissNotices"
  | "changeMyPassword"
  | "loadMe"
  | "logout"
  | "gateLocalLogin"
> {
  return {
    async gateLocalLogin() {
      const { token, employeeId, username } = get();
      if (!token) return null;
      // Either identifier matches: the lock table stores both.
      for (const key of [employeeId, username]) {
        if (key && (await window.blm.checkLocalLogin(key)).locked) {
          // Block this instance's session; keep storage so a later clean
          // restart (other instance gone) auto-logs-in as usual.
          set({ token: null, localLock: employeeId ?? key });
          return employeeId ?? key;
        }
      }
      // Not locked: register this instance so later instances see the lock.
      if (employeeId) void window.blm.acquireLocalLogin(employeeId, username ?? "");
      return null;
    },

    async login(serverUrl, username, password) {
      if ((await window.blm.checkLocalLogin(username)).locked) {
        throw new Error(t("li.localLock", { eid: username }));
      }
      const res = await fetch(`${apiBase(serverUrl)}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        if (res.status === 429) {
          const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
          const min = Math.max(1, Math.ceil((body.retry_after ?? 60) / 60));
          throw new Error(t("li.tooMany", { min }));
        }
        if (res.status === 403) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (body.error === "pending_review") throw new Error(t("li.reviewPending"));
          if (body.error === "review_rejected") throw new Error(t("li.reviewRejected"));
          throw new Error(t("li.disabled"));
        }
        throw new Error(res.status === 401 ? t("li.badCreds") : t("li.loginFail"));
      }
      // Trust the server's values: the cached username may differ from the input.
      const data = (await res.json()) as AuthResponse;
      saveIdentity(serverUrl, data.token, data.username, data.employee_id, data.role);
      set({
        serverUrl,
        token: data.token,
        username: data.username,
        employeeId: data.employee_id,
        role: data.role,
        error: null,
        localLock: null,
        registeredPending: null,
        authNotice: null,
      });
      void window.blm.acquireLocalLogin(data.employee_id, data.username);
      get().connect();
    },

    async register(serverUrl, employeeId, username, password) {
      if ((await window.blm.checkLocalLogin(employeeId)).locked) {
        throw new Error(t("li.localLock", { eid: employeeId }));
      }
      const res = await fetch(`${apiBase(serverUrl)}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, employee_id: employeeId }),
      });
      if (!res.ok) {
        if (res.status === 429) throw new Error(t("li.registerLimited"));
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(
            body.error === "employee_id_taken" ? t("li.employeeTaken") : t("li.usernameTaken"),
          );
        }
        if (res.status === 400) throw new Error(t("li.weak"));
        throw new Error(t("li.registerFail"));
      }
      const data = (await res.json()) as RegisterResponseData;
      // 新注册账号进入待审核：不签发登录态，显示等待审核页。
      if (data.status !== "approved") {
        set({ registeredPending: username, authNotice: null, error: null, localLock: null });
        return;
      }
      saveIdentity(serverUrl, data.token ?? "", data.username, data.employee_id, "user");
      set({
        serverUrl,
        token: data.token ?? null,
        username: data.username,
        employeeId: data.employee_id,
        role: "user",
        error: null,
        localLock: null,
        registeredPending: null,
        authNotice: null,
      });
      void window.blm.acquireLocalLogin(data.employee_id, data.username);
      get().connect();
    },

    dismissNotices() {
      set({ registeredPending: null, authNotice: null });
    },

    async changeMyPassword(oldPassword, newPassword) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/me/password`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
        });
        if (res.ok) {
          // 改密使所有旧 token 失效，登出回到登录屏并提示重新登录。
          get().logout();
          set({ authNotice: t("acc.pwChanged") });
          return "ok";
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "bad_credentials") return "bad_credentials";
        if (body.error === "bootstrap_password_env") return "bootstrap";
        return "fail";
      } catch {
        return "fail";
      }
    },

    async loadMe() {
      const { serverUrl, token } = get();
      if (!token) return;
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          username: string;
          employee_id: string;
          role: "admin" | "reviewer" | "user";
        };
        localStorage.setItem(LS.username, data.username);
        localStorage.setItem(LS.employeeId, data.employee_id);
        localStorage.setItem(LS.role, data.role);
        set({ username: data.username, employeeId: data.employee_id, role: data.role });
      } catch {
        // offline — keep the cached identity
      }
    },

    logout() {
      clearIdentity();
      void window.blm.releaseLocalLogin();
      setClosedByUser(true);
      resetReconnect();
      resetReconnectAttempt();
      currentSocket()?.close();
      setSocket(null);
      set({
        token: null,
        username: null,
        employeeId: null,
        role: "user",
        localLock: null,
        registeredPending: null,
        authNotice: null,
        sessions: [],
        sharedSessions: [],
        updateRequests: [],
        presence: {},
        currentSessionId: null,
        sharedView: false,
        blocksBySession: {},
        llmConfig: null,
      });
    },
  };
}
