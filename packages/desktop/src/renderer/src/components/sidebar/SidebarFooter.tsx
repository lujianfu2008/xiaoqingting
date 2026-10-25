import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { AdminUsersDialog } from "../admin/AdminUsersDialog";
import { UpdateRequestsDialog } from "../admin/UpdateRequestsDialog";

// Footer of the sidebar: identity (+ admin badge), connection state, the
// 公有域 review / user-management entries, and the logout button. The review
// entry is for everyone (requesters track their own requests); the pending
// count matters most to admins, who get live pushes over WS.
export function SidebarFooter(): React.JSX.Element {
  const wsStatus = useStore((s) => s.wsStatus);
  const username = useStore((s) => s.username);
  const employeeId = useStore((s) => s.employeeId);
  const role = useStore((s) => s.role);
  const updateRequests = useStore((s) => s.updateRequests);
  const loadUpdateRequests = useStore((s) => s.loadUpdateRequests);
  const logout = useStore((s) => s.logout);
  const [dialog, setDialog] = useState<"review" | "users" | null>(null);
  const t = useT();

  // 拉一次当前申请列表（此后靠 WS 推送实时增减）。
  useEffect(() => {
    void loadUpdateRequests();
  }, [loadUpdateRequests]);

  const pending = updateRequests.filter((r) => r.status === "pending").length;

  return (
    <>
      <div className="identity-row" title={t("ft.identityTip", { name: username ?? "", eid: employeeId ?? "" })}>
        {t("ft.eid", { eid: employeeId ?? "—" })} · {username ?? "—"}
        {role === "admin" && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              border: "1px solid #e5a83a",
              color: "#e5a83a",
              borderRadius: 4,
              padding: "0 4px",
              whiteSpace: "nowrap",
            }}
          >
            {t("ft.admin")}
          </span>
        )}
      </div>

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
        {role === "admin" && (
          <button
            style={{ fontSize: 12, padding: "4px 8px" }}
            title={t("au.title")}
            onClick={() => setDialog("users")}
          >
            {t("ft.adminPanel")}
          </button>
        )}
        <button style={{ fontSize: 12, padding: "4px 8px" }} onClick={logout}>
          {t("ft.logout")}
        </button>
      </div>

      {dialog === "review" && <UpdateRequestsDialog onClose={() => setDialog(null)} />}
      {dialog === "users" && <AdminUsersDialog onClose={() => setDialog(null)} />}
    </>
  );
}
