import { useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 账号面板：身份信息 + 本人修改密码。改密成功后服务端使所有旧 token 失效，
// 客户端自动登出回到登录屏。内置（bootstrap）管理员的密码在服务端 .env 中，
// 不支持在此修改。
export function AccountPanel(): React.JSX.Element {
  const username = useStore((s) => s.username);
  const employeeId = useStore((s) => s.employeeId);
  const role = useStore((s) => s.role);
  const changeMyPassword = useStore((s) => s.changeMyPassword);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const roleText =
    role === "admin" ? t("au.adminRole") : role === "reviewer" ? t("au.reviewerRole") : t("au.userRole");

  const submit = async (): Promise<void> => {
    setErr(null);
    if (newPw !== confirmPw) {
      setErr(t("acc.pwMismatch"));
      return;
    }
    setBusy(true);
    try {
      const r = await changeMyPassword(oldPw, newPw);
      if (r === "ok") {
        // 已自动登出；无需清空表单（组件随登录屏卸载）。
        return;
      }
      if (r === "bad_credentials") setErr(t("acc.oldPwWrong"));
      else if (r === "bootstrap") setErr(t("acc.bootstrapTip"));
      else setErr(t("acc.changeFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.8 }}>
        <div>
          {t("au.user")}：{username ?? "—"}
        </div>
        <div>
          {t("au.eid")}：{employeeId ?? "—"}
        </div>
        <div>
          {t("au.role")}：{roleText}
        </div>
      </div>

      <div className="field">
        <label>{t("acc.oldPw")}</label>
        <input
          type="password"
          value={oldPw}
          onChange={(e) => setOldPw(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <div className="field">
        <label>{t("acc.newPw")}</label>
        <input
          type="password"
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="field">
        <label>{t("acc.confirmPw")}</label>
        <input
          type="password"
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          autoComplete="new-password"
        />
      </div>

      {err && <div className="error-text">{err}</div>}

      <div>
        <button
          className="primary"
          disabled={busy || !oldPw || newPw.length < 6 || newPw !== confirmPw}
          onClick={() => void submit()}
        >
          {busy ? t("li.connecting") : t("acc.changePw")}
        </button>
      </div>
    </div>
  );
}
