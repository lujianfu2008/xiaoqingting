import type { AdminUserDetail, UpdateRequestView } from "@blm/protocol";
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
  | "setUserDisabled"
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
  };
}
