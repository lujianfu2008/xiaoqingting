import { useEffect, useState } from "react";
import type { AdminUserDetail, AuditEntry } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { AdminRelayPanel } from "./RelayPanel";

// 用户管理（公有域管理员）/ 注册审核（管理员 + 其授权的审核员）。
// manage = 全量用户管理（角色授权、禁用、审核）；review = 仅待审核注册列表。
// 内置（bootstrap）管理员不可降级/禁用 — 行内不提供这些操作，服务端同样拒绝。
export function AdminUsersDialog({
  mode,
  onClose,
}: {
  mode: "manage" | "review";
  onClose: () => void;
}): React.JSX.Element {
  const listAdminUsers = useStore((s) => s.listAdminUsers);
  const listReviewUsers = useStore((s) => s.listReviewUsers);
  const setUserRole = useStore((s) => s.setUserRole);
  const setUserDisabled = useStore((s) => s.setUserDisabled);
  const decideReviewUser = useStore((s) => s.decideReviewUser);
  const resetUserPassword = useStore((s) => s.resetUserPassword);
  const kickUser = useStore((s) => s.kickUser);
  const loadAuditLog = useStore((s) => s.loadAuditLog);
  const auditLog = useStore((s) => s.auditLog);
  const username = useStore((s) => s.username);
  const [users, setUsers] = useState<AdminUserDetail[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // manage 模式的小 tab：用户列表 / 操作日志（审计）/ 网络中继（仅管理员）。
  const [tab, setTab] = useState<"users" | "audit" | "relay">("users");
  // 行内重置密码：正在改的用户名 + 输入中的新密码（Electron 无 window.prompt）。
  const [resettingPw, setResettingPw] = useState<string | null>(null);
  const [pwInput, setPwInput] = useState("");
  const t = useT();

  const refresh = (): void => {
    void (mode === "manage" ? listAdminUsers() : listReviewUsers()).then(setUsers);
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

  const decide = (u: AdminUserDetail, approve: boolean): void =>
    run(u, () => decideReviewUser(u.username, approve));

  const confirmResetPw = (u: AdminUserDetail): void => {
    if (pwInput.length < 6) return;
    setBusy(u.username);
    void resetUserPassword(u.username, pwInput).then(() => {
      setBusy(null);
      setResettingPw(null);
      setPwInput("");
      refresh();
    });
  };

  // 待审核排最前，其次已拒绝，正常账号最后。
  const sorted = [...(users ?? [])].sort(
    (a, b) =>
      (a.status === "pending" ? 0 : a.status === "rejected" ? 1 : 2) -
      (b.status === "pending" ? 0 : b.status === "rejected" ? 1 : 2),
  );

  const roleLabel = (u: AdminUserDetail): string =>
    u.role === "admin" ? t("au.adminRole") : u.role === "reviewer" ? t("au.reviewerRole") : t("au.userRole");

  const statusBadge = (u: AdminUserDetail): React.JSX.Element | null => {
    if (u.status === "pending") {
      return (
        <span style={{ color: "#e5a83a", whiteSpace: "nowrap" }}>{t("au.reviewPending")}</span>
      );
    }
    if (u.status === "rejected") {
      return <span style={{ color: "#e56", whiteSpace: "nowrap" }}>{t("au.reviewRejected")}</span>;
    }
    return null;
  };

  const actionLabel = (action: AuditEntry["action"]): string => {
    const map: Record<string, string> = {
      "user.role_change": t("au.act.role"),
      "user.disable": t("au.act.disable"),
      "user.enable": t("au.act.enable"),
      "user.reset_password": t("au.act.resetPw"),
      "user.kick": t("au.act.kick"),
      "review.approve": t("au.act.approve"),
      "review.reject": t("au.act.reject"),
      "mcp.global_save": t("au.act.mcpSave"),
      "mcp.global_delete": t("au.act.mcpDelete"),
      "relay.config_save": t("au.act.relaySave"),
    };
    return map[action] ?? action;
  };

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 500, maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <h2>{mode === "manage" ? t("au.title") : t("ru.title")}</h2>

        {mode === "manage" && (
          <div style={{ display: "flex", gap: 6, padding: "0 8px 8px" }}>
            <button
              className={tab === "users" ? "primary" : ""}
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => setTab("users")}
            >
              {t("au.tabUsers")}
            </button>
            <button
              className={tab === "audit" ? "primary" : ""}
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => {
                setTab("audit");
                void loadAuditLog();
              }}
            >
              {t("au.tabAudit")}
            </button>
            <button
              className={tab === "relay" ? "primary" : ""}
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => setTab("relay")}
            >
              {t("set.tabRelay")}
            </button>
          </div>
        )}

        {tab === "relay" ? (
          <div style={{ padding: "0 8px" }}>
            <AdminRelayPanel />
          </div>
        ) : tab === "audit" ? (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 8px 6px" }}>
              <button
                style={{ fontSize: 11, padding: "2px 8px" }}
                onClick={() => void loadAuditLog()}
              >
                {t("au.auditRefresh")}
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                fontSize: 11,
                color: "var(--muted)",
                padding: "2px 8px 4px",
              }}
            >
              <span style={{ flex: 1.3 }}>{t("au.auditTime")}</span>
              <span style={{ flex: 0.9 }}>{t("au.auditActor")}</span>
              <span style={{ flex: 1 }}>{t("au.auditAction")}</span>
              <span style={{ flex: 0.9 }}>{t("au.auditTarget")}</span>
              <span style={{ flex: 1.6, textAlign: "right" }}>{t("au.auditDetail")}</span>
            </div>
            <div
              style={{ maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}
            >
              {auditLog.map((e, i) => {
                const detail = e.detail ? JSON.stringify(e.detail) : "";
                const short = detail.length > 40 ? detail.slice(0, 40) + "…" : detail;
                return (
                  <div
                    key={`${e.ts}-${i}`}
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
                    <span style={{ flex: 1.3, color: "var(--muted)", whiteSpace: "nowrap" }}>
                      {new Date(e.ts).toLocaleString()}
                    </span>
                    <span style={{ flex: 0.9, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.actor}
                    </span>
                    <span style={{ flex: 1, whiteSpace: "nowrap" }}>{actionLabel(e.action)}</span>
                    <span style={{ flex: 0.9, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.target}
                    </span>
                    <span
                      title={detail}
                      style={{
                        flex: 1.6,
                        color: "var(--muted)",
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {short}
                    </span>
                  </div>
                );
              })}
              {auditLog.length === 0 && (
                <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>
                  {t("au.auditEmpty")}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
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
          {sorted.map((u) => {
            const self = u.username === username;
            // 自己不能改自己；内置管理员任何人都改不了。
            const locked = self || u.immutable === true;
            const reviewable = mode === "review" || u.status !== "approved";
            return (
              <div
                key={u.username}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  border:
                    u.status === "pending" ? "1px solid #e5a83a" : "1px solid var(--border, #444)",
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
                  {roleLabel(u)}
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
                  {statusBadge(u)}
                </span>
                <span
                  style={{
                    flex: 2.4,
                    display: "flex",
                    gap: 4,
                    justifyContent: "flex-end",
                    flexWrap: "wrap",
                  }}
                >
                  {reviewable && (
                    <>
                      {u.status !== "approved" && (
                        <button
                          style={{ fontSize: 11, padding: "2px 6px" }}
                          disabled={busy === u.username}
                          onClick={() => decide(u, true)}
                        >
                          {t("ur.approve")}
                        </button>
                      )}
                      {u.status === "pending" && (
                        <button
                          style={{ fontSize: 11, padding: "2px 6px" }}
                          disabled={busy === u.username}
                          onClick={() => decide(u, false)}
                        >
                          {t("ur.reject")}
                        </button>
                      )}
                    </>
                  )}
                  {mode === "manage" && !locked && (
                    <>
                      {resettingPw === u.username ? (
                        // 行内输入新密码，确认后重置（目标用户会被强制下线）。
                        <>
                          <input
                            autoFocus
                            type="password"
                            value={pwInput}
                            placeholder={t("au.resetPwPh")}
                            style={{ fontSize: 11, padding: "2px 6px", width: 130 }}
                            onChange={(e) => setPwInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") confirmResetPw(u);
                              if (e.key === "Escape") {
                                setResettingPw(null);
                                setPwInput("");
                              }
                            }}
                          />
                          <button
                            style={{ fontSize: 11, padding: "2px 6px" }}
                            disabled={busy === u.username || pwInput.length < 6}
                            onClick={() => confirmResetPw(u)}
                          >
                            {t("au.pwConfirm")}
                          </button>
                          <button
                            style={{ fontSize: 11, padding: "2px 6px" }}
                            onClick={() => {
                              setResettingPw(null);
                              setPwInput("");
                            }}
                          >
                            {t("au.pwCancel")}
                          </button>
                        </>
                      ) : (
                        <>
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
                            onClick={() =>
                              run(u, () =>
                                setUserRole(u.username, u.role === "reviewer" ? "user" : "reviewer"),
                              )
                            }
                          >
                            {u.role === "reviewer" ? t("au.revokeReviewer") : t("au.makeReviewer")}
                          </button>
                          <button
                            style={{ fontSize: 11, padding: "2px 6px" }}
                            disabled={busy === u.username}
                            onClick={() => run(u, () => setUserDisabled(u.username, !u.disabled))}
                          >
                            {u.disabled ? t("au.enable") : t("au.disable")}
                          </button>
                          {u.online && (
                            <button
                              style={{ fontSize: 11, padding: "2px 6px" }}
                              disabled={busy === u.username}
                              title={t("au.kick")}
                              onClick={() => run(u, () => kickUser(u.username))}
                            >
                              {t("au.kick")}
                            </button>
                          )}
                          <button
                            style={{ fontSize: 11, padding: "2px 6px" }}
                            disabled={busy === u.username}
                            onClick={() => {
                              setResettingPw(u.username);
                              setPwInput("");
                            }}
                          >
                            {t("au.resetPw")}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {users !== null && users.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>
            {mode === "manage" ? t("au.noUsers") : t("ru.empty")}
          </div>
        )}
          </>
        )}

        <div className="actions">
          <button className="primary" onClick={onClose}>
            {t("set.done")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
