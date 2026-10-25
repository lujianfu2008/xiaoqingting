import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";
import { SettingsDialog } from "./SettingsDialog";
import { ShareDialog } from "./ShareDialog";
import { NewProjectDialog } from "./sidebar/NewProjectDialog";
import { SidebarAvatar } from "./sidebar/SidebarAvatar";
import { SessionList } from "./sidebar/SessionList";
import { SidebarFooter } from "./sidebar/SidebarFooter";

export function Sidebar(props: { chrome?: PaneChrome }): React.JSX.Element {
  const agents = useStore((s) => s.agents);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const newSession = useStore((s) => s.newSession);
  const setCurrentAgent = useStore((s) => s.setCurrentAgent);
  const trustMode = useStore((s) => s.trustMode);
  const setTrustMode = useStore((s) => s.setTrustMode);
  const sessions = useStore((s) => s.sessions);
  const t = useT();

  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // 应用菜单 → 设置… (main process forwards the click over IPC).
  useEffect(() => window.blm.onOpenSettings(() => setSettingsOpen(true)), []);

  return (
    <aside className="sidebar">
      {props.chrome && <PaneTools {...props.chrome} />}
      <SidebarAvatar />

      {/* 切换助手只影响之后「＋ 新对话」用哪个角色，不自动开新会话。 */}
      <select value={currentAgentId} onChange={(e) => setCurrentAgent(e.target.value)}>
        {agents.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {a.name} — {a.description}
          </option>
        ))}
        {agents.length === 0 && <option value={currentAgentId}>{t("side.defaultAgent")}</option>}
      </select>

      <button className="primary" onClick={() => void newSession(currentAgentId)}>
        {t("side.newChat")}
      </button>

      <div className="session-list">
        <SessionList onShare={setShareTarget} onNewProject={() => setNewProjectOpen(true)} />
      </div>

      <label
        title={t("side.trustTip")}
        style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 }}
      >
        <input
          type="checkbox"
          checked={trustMode}
          onChange={(e) => setTrustMode(e.target.checked)}
        />
        {t("side.trust")}
      </label>

      <button
        title={t("side.voiceTip")}
        style={{ fontSize: 12, padding: "4px 8px", alignSelf: "flex-start" }}
        onClick={() => setSettingsOpen(true)}
      >
        {t("side.settings")}
      </button>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} />}
      {shareTarget && (
        <ShareDialog
          session={sessions.find((s) => s.session_id === shareTarget)!}
          onClose={() => setShareTarget(null)}
        />
      )}

      <SidebarFooter />
    </aside>
  );
}
