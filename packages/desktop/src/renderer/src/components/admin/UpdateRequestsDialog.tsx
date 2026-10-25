import { useEffect, useState } from "react";
import type { UpdateRequestDetail, UpdateRequestView } from "@blm/protocol";
import { useStore } from "../../store";
import { apiBase } from "../../store/http";
import { useT } from "../../i18n";

// 公有域更新申请（审核流）：管理员在此批准/拒绝；普通用户查看自己的申请
// 状态。列表由 REST 拉取 + WS 实时刷新（store.messages 处理推送）。

function statusText(t: ReturnType<typeof useT>, s: UpdateRequestView["status"]): string {
  return s === "pending" ? t("ur.stPending") : s === "approved" ? t("ur.stApproved") : t("ur.stRejected");
}

function statusColor(s: UpdateRequestView["status"]): string {
  return s === "pending" ? "#e5a83a" : s === "approved" ? "#4aa36a" : "#e56";
}

export function UpdateRequestsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const requests = useStore((s) => s.updateRequests);
  const loadUpdateRequests = useStore((s) => s.loadUpdateRequests);
  const decideUpdateRequest = useStore((s) => s.decideUpdateRequest);
  const role = useStore((s) => s.role);
  const serverUrl = useStore((s) => s.serverUrl);
  const token = useStore((s) => s.token);

  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [detail, setDetail] = useState<UpdateRequestDetail | null>(null);
  // 拒绝需填原因：Electron 没有 window.prompt，用行内输入框。
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const t = useT();

  useEffect(() => {
    void loadUpdateRequests();
  }, [loadUpdateRequests]);

  const list = requests.filter((r) =>
    tab === "pending" ? r.status === "pending" : r.status !== "pending",
  );

  const openDetail = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${apiBase(serverUrl)}/api/update-requests/${id}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      if (!res.ok) return;
      setDetail((await res.json()) as UpdateRequestDetail);
    } catch {
      // ignore — button simply does nothing offline
    }
  };

  const decide = async (r: UpdateRequestView, approve: boolean, why?: string): Promise<void> => {
    const ok = await decideUpdateRequest(r.request_id, approve, why);
    if (ok) {
      setRejectFor(null);
      setReason("");
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ minWidth: 560, maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("ur.title")}</h2>

        <div style={{ display: "flex", gap: 8, margin: "4px 0 10px" }}>
          <button
            style={{ fontSize: 12, fontWeight: tab === "pending" ? 600 : 400 }}
            onClick={() => setTab("pending")}
          >
            {t("ur.pending")}
          </button>
          <button
            style={{ fontSize: 12, fontWeight: tab === "decided" ? 600 : 400 }}
            onClick={() => setTab("decided")}
          >
            {t("ur.decided")}
          </button>
        </div>

        {list.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "12px 0" }}>{t("ur.empty")}</div>
        )}

        <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((r) => (
            <div
              key={r.request_id}
              style={{ border: "1px solid var(--border, #444)", borderRadius: 8, padding: 8, fontSize: 12 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{statusText(t, r.status)}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.requester} · {r.project_name} · {r.path}
                </span>
                <span style={{ color: "var(--muted)" }}>{new Date(r.created_at).toLocaleString()}</span>
              </div>
              <div
                style={{
                  margin: "6px 0 0",
                  color: "var(--muted)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: 64,
                  overflowY: "auto",
                }}
              >
                {r.preview}
              </div>
              {r.reason && (
                <div style={{ marginTop: 4, color: "var(--muted)" }}>{r.reason}</div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 6, justifyContent: "flex-end" }}>
                {role === "admin" && (
                  <button style={{ fontSize: 12 }} onClick={() => void openDetail(r.request_id)}>
                    {t("ur.viewContent")}
                  </button>
                )}
                {role === "admin" && r.status === "pending" && rejectFor !== r.request_id && (
                  <>
                    <button
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setRejectFor(r.request_id);
                        setReason("");
                      }}
                    >
                      {t("ur.reject")}
                    </button>
                    <button
                      className="primary"
                      style={{ fontSize: 12 }}
                      onClick={() => void decide(r, true)}
                    >
                      {t("ur.approve")}
                    </button>
                  </>
                )}
              </div>
              {role === "admin" && rejectFor === r.request_id && (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input
                    autoFocus
                    value={reason}
                    placeholder={t("ur.reasonPh")}
                    style={{ flex: 1, fontSize: 12 }}
                    onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void decide(r, false, reason);
                      if (e.key === "Escape") setRejectFor(null);
                    }}
                  />
                  <button style={{ fontSize: 12 }} onClick={() => setRejectFor(null)}>
                    {t("np.cancel")}
                  </button>
                  <button
                    className="primary"
                    style={{ fontSize: 12 }}
                    onClick={() => void decide(r, false, reason)}
                  >
                    {t("ur.reject")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {detail && (
          <div
            className="overlay"
            onClick={() => setDetail(null)}
            style={{ position: "absolute", inset: 0, borderRadius: "inherit" }}
          >
            <div
              className="dialog"
              style={{ minWidth: 480, maxWidth: 680 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 style={{ fontSize: 14 }}>{detail.requester} · {detail.path}</h2>
              <pre
                style={{
                  maxHeight: 320,
                  overflow: "auto",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  background: "rgba(127,127,127,.08)",
                  padding: 8,
                  borderRadius: 6,
                }}
              >
                {detail.content}
              </pre>
              <div className="actions">
                <button className="primary" onClick={() => setDetail(null)}>
                  {t("set.done")}
                </button>
              </div>
            </div>
          </div>
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
