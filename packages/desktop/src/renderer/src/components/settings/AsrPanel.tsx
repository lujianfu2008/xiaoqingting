import { useStore } from "../../store";
import { useT } from "../../i18n";

export function AsrPanel(): React.JSX.Element {
  const vs = useStore((s) => s.voiceSettings);
  const update = useStore((s) => s.updateVoiceSettings);
  const wakeError = useStore((s) => s.wakeError);
  const t = useT();

  return (
    <>
      <div className="field">
        <label>{t("asr.afterSpace")}</label>
        <select
          value={vs.asrAutoSend ? "send" : "draft"}
          onChange={(e) => update({ asrAutoSend: e.target.value === "send" })}
        >
          <option value="send">{t("asr.send")}</option>
          <option value="draft">{t("asr.draft")}</option>
        </select>
      </div>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={vs.wakeEnabled}
            onChange={(e) => update({ wakeEnabled: e.target.checked })}
          />
          {t("asr.wake")}
        </label>
      </div>
      {vs.wakeEnabled && (
        <>
          <div className="field">
            <label>{t("asr.wakeWords")}</label>
            <input
              value={vs.wakeWords}
              placeholder={t("asr.wakeWordsPh")}
              onChange={(e) => update({ wakeWords: e.target.value })}
            />
            <p style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
              {t("asr.wakeHint")}
            </p>
          </div>
          <div className="field">
            <label>{t("asr.wakeSensitivity")}</label>
            <select
              value={vs.wakeSensitivity}
              onChange={(e) =>
                update({ wakeSensitivity: e.target.value as typeof vs.wakeSensitivity })
              }
            >
              <option value="low">{t("asr.wakeLow")}</option>
              <option value="medium">{t("asr.wakeMedium")}</option>
              <option value="high">{t("asr.wakeHigh")}</option>
            </select>
          </div>
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={vs.wakeContinuous}
                onChange={(e) => update({ wakeContinuous: e.target.checked })}
              />
              {t("asr.wakeContinuous")}
            </label>
          </div>
          {vs.wakeContinuous && (
            <>
              <div className="field">
                <label>{t("asr.wakeContinuousSecs")}</label>
                <select
                  value={String(vs.wakeContinuousSecs)}
                  onChange={(e) => update({ wakeContinuousSecs: Number(e.target.value) })}
                >
                  <option value="30">{t("asr.cont30")}</option>
                  <option value="60">{t("asr.cont60")}</option>
                  <option value="120">{t("asr.cont120")}</option>
                </select>
              </div>
              <p style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
                {t("asr.wakeContHint")}
              </p>
            </>
          )}
        </>
      )}
      {wakeError && (
        <p style={{ margin: 0, fontSize: 11, color: "#c0392b" }}>⚠ {wakeError}</p>
      )}
    </>
  );
}
