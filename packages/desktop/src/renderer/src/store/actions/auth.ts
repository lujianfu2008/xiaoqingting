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
  role: "admin" | "user";
}

export function createAuthActions(
  set: SetState,
  get: GetState,
): Pick<BlmState, "login" | "register" | "loadMe" | "logout" | "gateLocalLogin"> {
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
        if (res.status === 403) throw new Error(t("li.disabled"));
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
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(
            body.error === "employee_id_taken" ? t("li.employeeTaken") : t("li.usernameTaken"),
          );
        }
        if (res.status === 400) throw new Error(t("li.weak"));
        throw new Error(t("li.registerFail"));
      }
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
      });
      void window.blm.acquireLocalLogin(data.employee_id, data.username);
      get().connect();
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
          role: "admin" | "user";
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
