import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 管理页「网络中继」tab（仅管理员）：总开关（data/relay.json）+ 服务端内存
// 统计（排障三分法）。总开关翻转会丢弃空闲会话，下一条消息按新状态重建；
// V2 是消息级桥——目标由服务端逐请求给定，没有也不需要白名单。

export function AdminRelayPanel(): React.JSX.Element {
  const cfg = useStore((s) => s.adminRelayConfig);
  const loadAdminRelayConfig = useStore((s) => s.loadAdminRelayConfig);
  const saveAdminRelayConfig = useStore((s) => s.saveAdminRelayConfig);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void loadAdminRelayConfig();
  }, [loadAdminRelayConfig]);

  const save = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await saveAdminRelayConfig({ enabled });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("relay.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  const stats = cfg?.stats;

  return (
    <>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={cfg?.enabled ?? false}
            disabled={busy || !cfg}
            onChange={(e) => void save(e.target.checked)}
          />
          {t("relay.master")}
        </label>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--muted)" }}>
          {t("relay.masterHint")}
        </p>
      </div>

      {stats && (
        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.8 }}>
          <div>
            {t("relay.statsRequests", {
              total: stats.requests_total,
              failed: stats.requests_failed,
            })}
          </div>
          <div>{t("relay.statsOnline", { users: stats.bridge_online_users.join(", ") || "-" })}</div>
          <div>
            {stats.last_request
              ? t("relay.statsLast", {
                  line: `${stats.last_request.username} → ${stats.last_request.host} = ${
                    stats.last_request.ok ? "ok" : "fail"
                  }`,
                })
              : t("relay.statsNone")}
          </div>
          {stats.last_error && <div style={{ color: "var(--danger)" }}>{stats.last_error}</div>}
        </div>
      )}

      {msg && <div style={{ fontSize: 11, color: "var(--accent)" }}>{msg}</div>}

      <details style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
        <summary style={{ cursor: "pointer" }}>{t("relay.troubleshootTitle")}</summary>
        <p style={{ margin: "6px 0 0" }}>{t("relay.troubleshoot")}</p>
      </details>
    </>
  );
}
