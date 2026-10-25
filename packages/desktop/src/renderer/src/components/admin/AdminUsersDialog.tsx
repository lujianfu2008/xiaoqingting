import { useEffect, useState } from "react";
import type { AdminUserDetail } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 用户管理（仅公有域管理员）：工号列表、在线状态、角色授权、禁用/启用。
// 内置（bootstrap）管理员不可降级/禁用 — 行内不提供这些操作，服务端同样拒绝。
export function AdminUsersDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const listAdminUsers = useStore((s) => s.listAdminUsers);
  const setUserRole = useStore((s) => s.setUserRole);
  const setUserDisabled = useStore((s) => s.setUserDisabled);
  const username = useStore((s) => s.username);
  const [users, setUsers] = useState<AdminUserDetail[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const t = useT();

  const refresh = (): void => {
    void listAdminUsers().then(setUsers);
  };

  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (u: AdminUserDetail, fn: () => Promise<boolean>): void => {
    setBusy(u.username);
    void fn().then(() => {
      setBusy(null);
      refresh();
    });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ minWidth: 500, maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("au.title")}</h2>

        <div
          style={{
            display: "flex",
            gap: 8,
            fontSize: 11,
            color: "var(--muted)",
            padding: "2px 8px 4px",
          }}
        >
          <span style={{ flex: 1.2 }}>{t("au.user")}</span>
          <span style={{ flex: 1 }}>{t("au.eid")}</span>
          <span style={{ flex: 1 }}>{t("au.role")}</span>
          <span style={{ flex: 1.4, textAlign: "right" }}>{t("au.status")}</span>
        </div>

        <div style={{ maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {(users ?? []).map((u) => {
            const self = u.username === username;
            // 自己不能改自己；内置管理员任何人都改不了。
            const locked = self || u.immutable === true;
            return (
              <div
                key={u.username}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  border: "1px solid var(--border, #444)",
                  borderRadius: 8,
                  padding: "6px 8px",
                }}
              >
                <span style={{ flex: 1.2, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {u.username}
                  {self && <span style={{ color: "var(--muted)" }}>{t("au.self")}</span>}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: "var(--muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {u.employee_id}
                </span>
                <span style={{ flex: 1, whiteSpace: "nowrap" }}>
                  {u.role === "admin" ? t("au.adminRole") : t("au.userRole")}
                  {u.immutable && (
                    <span title={t("au.immutable")} style={{ color: "#e5a83a" }}>
                      ★
                    </span>
                  )}
                </span>
                <span style={{ flex: 0.7, display: "flex", alignItems: "center", gap: 4 }}>
                  <span
                    className={`status-dot ${u.online ? "ok" : "bad"}`}
                    title={u.online ? t("au.online") : t("au.offline")}
                  />
                  {u.disabled && <span style={{ color: "#e56" }}>{t("au.disabled")}</span>}
                </span>
                {!locked && (
                  <span
                    style={{
                      flex: 1.6,
                      display: "flex",
                      gap: 4,
                      justifyContent: "flex-end",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      style={{ fontSize: 11, padding: "2px 6px" }}
                      disabled={busy === u.username}
                      onClick={() =>
                        run(u, () =>
                          setUserRole(u.username, u.role === "admin" ? "user" : "admin"),
                        )
                      }
                    >
                      {u.role === "admin" ? t("au.revokeAdmin") : t("au.makeAdmin")}
                    </button>
                    <button
                      style={{ fontSize: 11, padding: "2px 6px" }}
                      disabled={busy === u.username}
                      onClick={() => run(u, () => setUserDisabled(u.username, !u.disabled))}
                    >
                      {u.disabled ? t("au.enable") : t("au.disable")}
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {users !== null && users.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>{t("ur.empty")}</div>
        )}

        <div className="actions">
          <button className="primary" onClick={onClose}>
            {t("set.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
