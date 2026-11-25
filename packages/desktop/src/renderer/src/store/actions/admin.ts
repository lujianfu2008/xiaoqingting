import type {
  AdminUserDetail,
  AuditEntry,
  DiagDetailResponse,
  DiagEntryMeta,
  DiagListResponse,
  DiagTaskDetailResponse,
  DiagTaskKind,
  DiagTaskListResponse,
  UpdateRequestView,
} from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { apiBase } from "../http";
import { t } from "../../i18n";

// 公有域管理：更新申请（审核流）与用户管理（角色/禁用）。仅管理员可用的
// 端点；普通用户调用 listUpdateRequests 时服务端自动收窄为自己的申请。

export function createAdminActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "loadUpdateRequests"
  | "decideUpdateRequest"
  | "listAdminUsers"
  | "setUserRole"
  | "setUserPublicExec"
  | "setUserDisabled"
  | "listReviewUsers"
  | "decideReviewUser"
  | "resetUserPassword"
  | "kickUser"
  | "deleteAdminUser"
  | "loadAuditLog"
  | "deleteAuditEntry"
  | "clearAuditLog"
  | "collectDiagFrom"
  | "loadDiagList"
  | "loadDiagDetail"
  | "deleteDiagEntry"
  | "startDiagTask"
  | "loadDiagTaskList"
  | "loadDiagTaskDetail"
  | "deleteDiagTask"
> {
  // 非 2xx → 转成提示并返回 false（immutable_account 是内置管理员的预期拒绝）。
  const okOrToast = async (res: Response): Promise<boolean> => {
    if (res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    set({
      error:
        body.message ??
        (body.error === "immutable_account" ? t("au.immutable") : t("ur.decideFail")),
    });
    return false;
  };

  return {
    async loadUpdateRequests() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/update-requests`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { requests: UpdateRequestView[] };
        set({ updateRequests: data.requests });
      } catch {
        // offline — keep the last list
      }
    },

    async decideUpdateRequest(id, approve, reason) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/update-requests/${id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ approve, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          set({ error: body.message ?? t("ur.decideFail") });
          return false;
        }
        const updated = (await res.json()) as UpdateRequestView;
        set((s) => ({
          updateRequests: s.updateRequests.map((r) => (r.request_id === id ? updated : r)),
        }));
        return true;
      } catch {
        return false;
      }
    },

    async listAdminUsers() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { users: AdminUserDetail[] };
        return data.users;
      } catch {
        return [];
      }
    },

    async setUserRole(username, role) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}/role`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ role }),
          },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    async setUserDisabled(username, disabled) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}/disabled`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ disabled }),
          },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    async setUserPublicExec(username, enabled) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}/public-exec`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ enabled }),
          },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    async listReviewUsers() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/review/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { users: AdminUserDetail[] };
        return data.users;
      } catch {
        return [];
      }
    },

    async decideReviewUser(username, approve) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/review/users/${encodeURIComponent(username)}/decide`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ approve }),
          },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    async resetUserPassword(username, password) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}/password`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ password }),
          },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    async kickUser(username) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}/kick`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        return await okOrToast(res);
      } catch {
        return false;
      }
    },

    /** 删除用户账号（全量级联）。返回错误码字符串或 null（成功）。 */
    async deleteAdminUser(username): Promise<string | null> {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/users/${encodeURIComponent(username)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        );
        if (res.ok) return null;
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        const code = body.error ?? body.message ?? "fail";
        if (code === "user_has_active_tasks_or_schedules") {
          set({ error: t("au.deleteUserBlocked") });
        } else if (code === "cannot_delete_self") {
          set({ error: t("au.deleteSelf") });
        }
        return code;
      } catch {
        return "network";
      }
    },

    /** 删除一条审计日志。返回是否成功。 */
    async deleteAuditEntry(ts, actor, action) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/audit/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ts, actor, action }),
        });
        if (!res.ok) return false;
        set((s) => ({
          auditLog: s.auditLog.filter(
            (e) => !(e.ts === ts && e.actor === actor && e.action === action),
          ),
        }));
        return true;
      } catch {
        return false;
      }
    },

    /** 清空全部审计日志。返回是否成功。 */
    async clearAuditLog() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/audit/clear`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        set({ auditLog: [] });
        return true;
      } catch {
        return false;
      }
    },

    async loadAuditLog(limit = 100) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/audit?limit=${limit}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { entries: AuditEntry[] };
        set({ auditLog: data.entries });
        return true;
      } catch {
        return false;
      }
    },

    // ---------- 显示诊断（仅管理员） ----------

    /** 向在线用户发起一次采集。返回错误码（null = 已发起）。 */
    async collectDiagFrom(username, scope) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/diag/${encodeURIComponent(username)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ scope }),
        });
        if (res.ok) return null;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return body.error ?? "fail";
      } catch {
        return "network";
      }
    },

    async loadDiagList() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/diag`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const data = (await res.json()) as DiagListResponse;
        set({ diagList: data.entries });
        return true;
      } catch {
        return false;
      }
    },

    async loadDiagDetail(id) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/diag/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return (await res.json()) as DiagDetailResponse;
      } catch {
        return null;
      }
    },

    /** 删除一条诊断存档。返回是否成功。 */
    async deleteDiagEntry(id) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/diag/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        set((s) => ({ diagList: s.diagList.filter((e) => e.id !== id) }));
        return true;
      } catch {
        return false;
      }
    },

    // ---------- 远程诊断任务（借用在线客户端的智能体） ----------

    /** 发起一个诊断任务。返回错误码（null = 已发起）。 */
    async startDiagTask(username, kind) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/diag-task/${encodeURIComponent(username)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ kind }),
          },
        );
        if (res.ok) return null;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return body.error ?? "fail";
      } catch {
        return "network";
      }
    },

    async loadDiagTaskList() {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(`${apiBase(serverUrl)}/api/admin/diag-task`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const data = (await res.json()) as DiagTaskListResponse;
        set({ diagTaskList: data.entries });
        return true;
      } catch {
        return false;
      }
    },

    async loadDiagTaskDetail(id) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/diag-task/${encodeURIComponent(id)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return null;
        return (await res.json()) as DiagTaskDetailResponse;
      } catch {
        return null;
      }
    },

    async deleteDiagTask(id) {
      const { serverUrl, token } = get();
      try {
        const res = await fetch(
          `${apiBase(serverUrl)}/api/admin/diag-task/${encodeURIComponent(id)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
