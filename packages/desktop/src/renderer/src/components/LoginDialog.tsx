import { useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { DragonflyLogo } from "./DragonflyLogo";

export function LoginDialog(): React.JSX.Element {
  const login = useStore((s) => s.login);
  const register = useStore((s) => s.register);
  const dismissNotices = useStore((s) => s.dismissNotices);
  const localLock = useStore((s) => s.localLock);
  const registeredPending = useStore((s) => s.registeredPending);
  const authNotice = useStore((s) => s.authNotice);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [url, setUrl] = useState(useStore.getState().serverUrl || "http://localhost:8788");
  const [employeeId, setEmployeeId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    dismissNotices();
    try {
      const base = url.replace(/\/+$/, "");
      if (mode === "login") await login(base, username.trim(), password);
      else await register(base, employeeId.trim(), username.trim(), password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 注册成功但待审核：显示等待审核页，审核通过后才能登录。
  if (registeredPending) {
    return (
      <div className="overlay">
        <div className="dialog" style={{ minWidth: 360, textAlign: "center" }}>
          <h2 style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <DragonflyLogo size={36} />
            <span>小蜻蜓</span>
          </h2>
          <div style={{ fontSize: 14, margin: "12px 0 6px" }}>{t("li.pendingTitle")}</div>
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
            {t("li.pendingBody", { name: registeredPending })}
          </div>
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                dismissNotices();
                setMode("login");
              }}
            >
              {t("li.backLogin")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay">
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <DragonflyLogo size={36} />
          <span>小蜻蜓</span>
        </h2>
        <div className="field">
          <label>{t("li.server")}</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://blm.example.com" />
        </div>
        {mode === "register" && (
          <div className="field">
            <label>{t("li.employee")}</label>
            <input
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder={t("li.employeePh")}
            />
          </div>
        )}
        <div className="field">
          <label>{t("li.username")}</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>
            {t("li.password")}
            {mode === "register" ? t("li.passwordMin") : ""}
          </label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {localLock && (
          <div className="error-text">
            {t("li.localLock", { eid: localLock })}
          </div>
        )}
        {authNotice && <div className="error-text">{authNotice}</div>}
        {err && <div className="error-text">{err}</div>}
        <div className="actions">
          <button
            className="primary"
            type="submit"
            disabled={
              busy || !username || !password || (mode === "register" && employeeId.trim().length < 2)
            }
          >
            {busy ? t("li.connecting") : mode === "login" ? t("li.login") : t("li.register")}
          </button>
        </div>
        <div style={{ textAlign: "center", marginTop: 8 }}>
          <button
            type="button"
            style={{ fontSize: 12, background: "none", border: "none", color: "var(--muted)", cursor: "pointer" }}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setErr(null);
              dismissNotices();
            }}
          >
            {mode === "login" ? t("li.noAccount") : t("li.hasAccount")}
          </button>
        </div>
      </form>
    </div>
  );
}
