import { useState } from "react";
import { useT } from "../i18n";
import { Overlay } from "./Overlay";
import { GeneralPanel } from "./settings/GeneralPanel";
import { LlmPanel } from "./settings/LlmPanel";
import { RelayPanel } from "./settings/RelayPanel";
import { McpPanel } from "./settings/McpPanel";
import { SkillsPanel } from "./settings/SkillsPanel";
import { WorkflowsPanel } from "./settings/WorkflowsPanel";
import { SchedulesPanel } from "./settings/SchedulesPanel";
import { VoicePanel } from "./settings/VoicePanel";
import { AsrPanel } from "./settings/AsrPanel";
import { AccountPanel } from "./settings/AccountPanel";

// Settings panel, split into left-nav tabs so the (long) form never overflows
// the window. All voice values persist in localStorage (blm.voiceSettings /
// blm.autoRead); the LLM and MCP configs live on the server.

type Tab =
  | "general"
  | "llm"
  | "relay"
  | "mcp"
  | "skills"
  | "workflows"
  | "schedules"
  | "voice"
  | "asr"
  | "account";

const TAB_KEYS = [
  { id: "general", key: "set.tabGeneral" },
  { id: "llm", key: "set.tabLlm" },
  { id: "relay", key: "set.tabRelay" },
  { id: "mcp", key: "set.tabMcp" },
  { id: "skills", key: "set.tabSkills" },
  { id: "workflows", key: "set.tabWorkflows" },
  { id: "schedules", key: "set.tabSchedules" },
  { id: "voice", key: "set.tabVoice" },
  { id: "asr", key: "set.tabAsr" },
  { id: "account", key: "set.tabAccount" },
] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<Tab>("general");

  return (
    <Overlay onClose={onClose} closeOnOutside={false}>
      <div className="dialog settings" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>{t("set.title")}</h2>
          <button
            className="dialog-close"
            title={t("set.close")}
            aria-label={t("set.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
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
            <div className={`settings-pane ${tab === "relay" ? "" : "hidden"}`}>
              <RelayPanel />
            </div>
            <div className={`settings-pane ${tab === "mcp" ? "" : "hidden"}`}>
              <McpPanel />
            </div>
            <div className={`settings-pane ${tab === "skills" ? "" : "hidden"}`}>
              <SkillsPanel />
            </div>
            <div className={`settings-pane ${tab === "workflows" ? "" : "hidden"}`}>
              <WorkflowsPanel />
            </div>
            <div className={`settings-pane ${tab === "schedules" ? "" : "hidden"}`}>
              <SchedulesPanel onClose={onClose} />
            </div>
            <div className={`settings-pane ${tab === "voice" ? "" : "hidden"}`}>
              <VoicePanel />
            </div>
            <div className={`settings-pane ${tab === "asr" ? "" : "hidden"}`}>
              <AsrPanel />
            </div>
            <div className={`settings-pane ${tab === "account" ? "" : "hidden"}`}>
              <AccountPanel />
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="primary" onClick={onClose}>
            {t("set.done")}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
