import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useT } from "../../i18n";

export function VoicePanel(): React.JSX.Element {
  const autoRead = useStore((s) => s.autoRead);
  const setAutoRead = useStore((s) => s.setAutoRead);
  const vs = useStore((s) => s.voiceSettings);
  const update = useStore((s) => s.updateVoiceSettings);
  const [voices, setVoices] = useState<{ name: string; culture: string }[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const t = useT();

  useEffect(() => {
    let alive = true;
    void window.blm.listVoices().then((v) => {
      if (alive) {
        // Chinese voices first
        v.sort((a, b) => Number(b.culture.startsWith("zh")) - Number(a.culture.startsWith("zh")));
        setVoices(v);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const preview = (): void => {
    setPreviewing(true);
    // Pass the (possibly unsaved) dialog values explicitly. `speaking` flips
    // back to false when the main process reports the speech ended.
    useStore.getState().speak(t("voice.previewText"), {
      voice: vs.ttsVoice,
      rate: vs.ttsRate,
      volume: vs.ttsVolume,
    });
    const check = setInterval(() => {
      if (!useStore.getState().speaking) {
        clearInterval(check);
        setPreviewing(false);
      }
    }, 300);
  };

  return (
    <>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={autoRead} onChange={(e) => setAutoRead(e.target.checked)} />
          {t("voice.autoRead")}
        </label>
      </div>

      <div className="field">
        <label>{t("voice.voice")}</label>
        <select value={vs.ttsVoice} onChange={(e) => update({ ttsVoice: e.target.value })}>
          <option value="">{t("voice.default")}</option>
          {voices.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}（{v.culture}）
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>{t("voice.rate", { v: vs.ttsRate > 0 ? `+${vs.ttsRate}` : vs.ttsRate })}</label>
        <input
          type="range"
          min={-10}
          max={10}
          step={1}
          value={vs.ttsRate}
          onChange={(e) => update({ ttsRate: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>{t("voice.volume", { v: vs.ttsVolume })}</label>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={vs.ttsVolume}
          onChange={(e) => update({ ttsVolume: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <button style={{ fontSize: 12 }} onClick={preview} disabled={previewing}>
          {previewing ? t("voice.previewing") : t("voice.preview")}
        </button>
      </div>
    </>
  );
}
