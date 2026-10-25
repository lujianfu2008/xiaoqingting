import { useStore } from "../../store";
import { useT } from "../../i18n";

export function AsrPanel(): React.JSX.Element {
  const vs = useStore((s) => s.voiceSettings);
  const update = useStore((s) => s.updateVoiceSettings);
  const t = useT();

  return (
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
  );
}
