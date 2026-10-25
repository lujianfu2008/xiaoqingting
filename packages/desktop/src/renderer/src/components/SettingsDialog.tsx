import { useState } from "react";
import { useT } from "../i18n";
import { GeneralPanel } from "./settings/GeneralPanel";
import { LlmPanel } from "./settings/LlmPanel";
import { VoicePanel } from "./settings/VoicePanel";
import { AsrPanel } from "./settings/AsrPanel";

// Settings panel, split into left-nav tabs so the (long) form never overflows
// the window. All voice values persist in localStorage (blm.voiceSettings /
// blm.autoRead); the LLM config lives on the server.

type Tab = "general" | "llm" | "voice" | "asr";

const TAB_KEYS = [
  { id: "general", key: "set.tabGeneral" },
  { id: "llm", key: "set.tabLlm" },
  { id: "voice", key: "set.tabVoice" },
  { id: "asr", key: "set.tabAsr" },
] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog settings" onClick={(e) => e.stopPropagation()}>
        <h2>{t("set.title")}</h2>
        <div className="settings-body">
          <nav className="settings-tabs">
            {TAB_KEYS.map((tb) => (
              <button
                key={tb.id}
                className={`settings-tab ${tab === tb.id ? "active" : ""}`}
                onClick={() => setTab(tb.id)}
              >
                {t(tb.key)}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {/* Panels stay mounted (hidden) so switching tabs does not drop
                half-typed values or re-query the system voice list. */}
            <div className={`settings-pane ${tab === "general" ? "" : "hidden"}`}>
              <GeneralPanel />
            </div>
            <div className={`settings-pane ${tab === "llm" ? "" : "hidden"}`}>
              <LlmPanel />
            </div>
            <div className={`settings-pane ${tab === "voice" ? "" : "hidden"}`}>
              <VoicePanel />
            </div>
            <div className={`settings-pane ${tab === "asr" ? "" : "hidden"}`}>
              <AsrPanel />
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="primary" onClick={onClose}>
            {t("set.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
