import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { AdminUsersDialog } from "../admin/AdminUsersDialog";
import { UpdateRequestsDialog } from "../admin/UpdateRequestsDialog";

// Footer of the sidebar: connection state, the 公有域 review / user-management
// entries, and the logout button. The review entry is for everyone (requesters
// track their own requests); the pending count matters most to admins, who get
// live pushes over WS. 注册审核入口对管理员（完整用户管理）和审核员（仅注册审核）
// 开放，带待审数量角标。身份（工号·用户名）移去了聊天输入框下方。
export function SidebarFooter(): React.JSX.Element {
  const wsStatus = useStore((s) => s.wsStatus);
  const role = useStore((s) => s.role);
  const updateRequests = useStore((s) => s.updateRequests);
  const loadUpdateRequests = useStore((s) => s.loadUpdateRequests);
  const listReviewUsers = useStore((s) => s.listReviewUsers);
  const pendingReviewCount = useStore((s) => s.pendingReviewCount);
  const logout = useStore((s) => s.logout);
  const [dialog, setDialog] = useState<"review" | "users" | null>(null);
  const t = useT();

  // 拉一次当前申请列表（此后靠 WS 推送实时增减）。
  useEffect(() => {
    void loadUpdateRequests();
  }, [loadUpdateRequests]);

  // 待审核注册数量：挂载时和用户弹窗开关后各拉一次作初值；此后以 WS 推送为准。
  useEffect(() => {
    if (role !== "admin" && role !== "reviewer") return;
    void listReviewUsers().then((us) => useStore.setState({ pendingReviewCount: us.length }));
  }, [role, dialog, listReviewUsers]);

  const pending = updateRequests.filter((r) => r.status === "pending").length;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
        <span
          className={`status-dot ${wsStatus === "connected" ? "ok" : wsStatus === "connecting" ? "warn" : "bad"}`}
        />
        {wsStatus === "connected" ? t("ft.connected") : wsStatus === "connecting" ? t("ft.connecting") : t("ft.disconnected")}
        <span style={{ flex: 1 }} />
        <button
          style={{ fontSize: 12, padding: "4px 8px" }}
          title={t("ur.title")}
          onClick={() => setDialog("review")}
        >
          {t("ft.review")}
          {pending > 0 ? ` (${pending})` : ""}
        </button>
        {(role === "admin" || role === "reviewer") && (
          <button
            style={{ fontSize: 12, padding: "4px 8px" }}
            title={role === "admin" ? t("au.title") : t("ru.title")}
            onClick={() => setDialog("users")}
          >
            {role === "admin" ? t("ft.adminPanel") : t("ft.reviewPanel")}
            {pendingReviewCount > 0 ? ` (${pendingReviewCount})` : ""}
          </button>
        )}
        <button style={{ fontSize: 12, padding: "4px 8px" }} onClick={logout}>
          {t("ft.logout")}
        </button>
      </div>

      {dialog === "review" && <UpdateRequestsDialog onClose={() => setDialog(null)} />}
      {dialog === "users" && (
        <AdminUsersDialog mode={role === "admin" ? "manage" : "review"} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
