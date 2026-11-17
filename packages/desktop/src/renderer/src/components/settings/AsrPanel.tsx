import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { getWakeDiag } from "../../wakeListener";
import type { ModelState } from "@blm/protocol";

// 语音模型按需下载区：安装包不含模型（省 ~83MB），首用语音
// 时在这里拉取。状态来自 main/modelFetch.ts（blm:models:state
// 推送 + 本地播种）。

const MODEL_LABELS = {
  "sherpa-paraformer": "语音识别（说话转文字）",
  "sherpa-kws": "语音唤醒（喊一声唤醒词）",
} as const;

export function AsrPanel(): React.JSX.Element {
  const vs = useStore((s) => s.voiceSettings);
  const update = useStore((s) => s.updateVoiceSettings);
  const wakeError = useStore((s) => s.wakeError);
  const t = useT();
  // 唤醒诊断快照：500ms 轮询刷新（recv/sent 数字跳 = 采音在跑）。
  const [wakeDiag, setWakeDiag] = useState(getWakeDiag());
  useEffect(() => {
    const timer = setInterval(() => setWakeDiag(getWakeDiag()), 500);
    return () => clearInterval(timer);
  }, []);
  // 播种 + 推送合并的模型状态（keyed by name）。
  const [models, setModels] = useState<Record<string, ModelState>>({});
  useEffect(() => {
    let alive = true;
    void window.blm.modelsState().then((list) => {
      if (!alive) return;
      setModels(Object.fromEntries(list.map((m) => [m.name, m])));
    });
    const off = window.blm.onModelState((s) => {
      setModels((cur) => ({ ...cur, [s.name]: s }));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const modelRow = (name: keyof typeof MODEL_LABELS): React.JSX.Element => {
    const m = models[name];
    const ready = m?.ready ?? false;
    const downloading = m?.phase === "downloading";
    return (
      <div
        key={name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
          fontSize: 12,
        }}
      >
        <span style={{ color: ready ? "var(--ok, #4caf50)" : "var(--muted)" }}>
          {ready ? "✓" : "○"}
        </span>
        <span style={{ flex: 1 }}>{MODEL_LABELS[name]}</span>
        {downloading ? (
          <span style={{ color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
            {m.percent}%
          </span>
        ) : ready ? (
          <span style={{ color: "var(--muted)", fontSize: 11 }}>{t("asr.modelReady")}</span>
        ) : (
          <button
            disabled={m?.phase === "downloading"}
            onClick={() => void window.blm.downloadModel(name)}
          >
            {m?.phase === "error" ? t("asr.modelRetry") : t("asr.modelDownload")}
          </button>
        )}
      </div>
    );
  };

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
        <label>{t("asr.models")}</label>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--muted)" }}>
          {t("asr.modelsHint")}
        </p>
        {modelRow("sherpa-paraformer")}
        {modelRow("sherpa-kws")}
        {Object.values(models).some((m) => m.phase === "error") && (
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--danger)" }}>
            {Object.values(models)
              .filter((m) => m.phase === "error")
              .map((m) => `${MODEL_LABELS[m.name]}：${m.error ?? t("asr.modelFail")}`)
              .join("；")}
          </p>
        )}
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
          {/* 唤醒监听诊断：ctx 状态 + 四个块计数。
              recv=0 → 回调没在跑（ctx 暂停/设备僵死）；
              gate 一直涨 → 被录音/朗读/弹窗门控挡住；
              silent 涨而 sent=0 → 设备在送静音（切设备/被独占）；
              sent 跳动却不命中 → 词表或灵敏度问题。 */}
          <p style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            {t("asr.wakeDiag")}: ctx={wakeDiag.ctxState} recv={wakeDiag.recv}{" "}
            gate={wakeDiag.gate} silent={wakeDiag.silent} sent={wakeDiag.sent}
          </p>
        </>
      )}
      {wakeError && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--danger)" }}>⚠ {wakeError}</p>
      )}
    </>
  );
}
