import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 网络中继（用户侧）：opt-in 开关（REST /api/me/relay）+ 本机连接状态。
// 出网走 Electron net（自动跟随系统代理/PAC），无需任何本地配置。

interface LocalRelayStatus {
  enabled: boolean;
  connected: boolean;
  active_requests: number;
  requests_total: number;
  requests_failed: number;
}

export function RelayPanel(): React.JSX.Element {
  const myRelay = useStore((s) => s.myRelay);
  const loadMyRelay = useStore((s) => s.loadMyRelay);
  const setMyRelayOptIn = useStore((s) => s.setMyRelayOptIn);
  const [local, setLocal] = useState<LocalRelayStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void loadMyRelay();
  }, [loadMyRelay]);

  // 本地连接状态轮询（main 进程内存态，无 WS 推送）。
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      void window.blm.relayStatus().then((s) => {
        if (alive) setLocal(s);
      });
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const toggleOptIn = async (on: boolean): Promise<void> => {
    setMsg(null);
    try {
      await setMyRelayOptIn(on);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t("relay.saveFail"));
    }
  };

  const masterOff = myRelay ? !myRelay.master_enabled : false;

  return (
    <>
      <p style={{ marginTop: 0, fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
        {t("relay.note")}
      </p>

      {myRelay && masterOff && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--warn)" }}>⚠ {t("relay.masterOff")}</p>
      )}

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            disabled={!!myRelay && masterOff}
            checked={myRelay?.opt_in ?? false}
            onChange={(e) => void toggleOptIn(e.target.checked)}
          />
          {t("relay.optIn")}
        </label>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
        {t("relay.localState")}
        {local?.enabled ? (
          local.connected ? (
            <span style={{ color: "var(--ok)" }}>{t("relay.on")}</span>
          ) : (
            <span style={{ color: "var(--warn)" }}>{t("relay.off")}</span>
          )
        ) : (
          t("relay.off")
        )}
        {local?.enabled && local.connected && local.requests_total > 0 && (
          <>
            {" · "}
            {t("relay.requests", {
              n: local.active_requests,
              total: local.requests_total,
              failed: local.requests_failed,
            })}
          </>
        )}
        {msg && <div style={{ marginTop: 4, color: "var(--accent)" }}>{msg}</div>}
      </div>
    </>
  );
}
