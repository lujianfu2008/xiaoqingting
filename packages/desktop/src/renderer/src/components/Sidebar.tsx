import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { LS } from "../store/persist";
import { PaneTools, type PaneChrome } from "./pane/PaneTools";
import { Splitter } from "./Splitter";
import { SettingsDialog } from "./SettingsDialog";
import { ShareDialog } from "./ShareDialog";
import { NewProjectDialog } from "./sidebar/NewProjectDialog";
import { SidebarAvatar } from "./sidebar/SidebarAvatar";
import { SessionList } from "./sidebar/SessionList";
import { SidebarFooter } from "./sidebar/SidebarFooter";

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
// Absent/invalid localStorage value → null (= follow the CSS defaults).
const loadOptNum = (key: string): number | null => {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function Sidebar(props: { chrome?: PaneChrome }): React.JSX.Element {
  const agents = useStore((s) => s.agents);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const newSession = useStore((s) => s.newSession);
  const setCurrentAgent = useStore((s) => s.setCurrentAgent);
  const avatarMode = useStore((s) => s.avatarMode);
  const sessions = useStore((s) => s.sessions);
  const t = useT();

  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // 形象区高度（px）。null = 跟随 CSS 默认（蜻蜓 15% / 数字人 24%）；双击 split
  // 复位回 null。数字人 stage / 蜻蜓 SVG 都随容器自适应。
  const [avatarH, setAvatarH] = useState<number | null>(() => loadOptNum(LS.sidebarAvatarH));
  // 形象区收起：隐藏 hero 只留一条细条，点细条展开（拖拽出来的高度记忆保留）。
  const [avatarCollapsed, setAvatarCollapsed] = useState(
    () => localStorage.getItem(LS.sidebarAvatarCollapsed) === "1",
  );
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (avatarH === null) localStorage.removeItem(LS.sidebarAvatarH);
    else localStorage.setItem(LS.sidebarAvatarH, String(avatarH));
  }, [avatarH]);
  useEffect(() => {
    if (avatarCollapsed) localStorage.setItem(LS.sidebarAvatarCollapsed, "1");
    else localStorage.removeItem(LS.sidebarAvatarCollapsed);
  }, [avatarCollapsed]);

  // 应用菜单 → 设置… (main process forwards the click over IPC).
  useEffect(() => window.blm.onOpenSettings(() => setSettingsOpen(true)), []);

  // 形象区高度钳制：min 与 CSS min-height 一致（防状态行被裁），max 留一半屏幕给列表。
  const avatarMin = avatarMode === "digitalhuman" ? 170 : 96;
  const avatarMax = Math.min(window.innerHeight * 0.7, 560);
  const dragAvatar = (clientY: number): void => {
    const rect = asideRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAvatarH(clamp(Math.round(clientY - rect.top), avatarMin, avatarMax));
  };

  return (
    <aside className="sidebar" ref={asideRef}>
      {props.chrome && <PaneTools {...props.chrome} />}
      {avatarCollapsed ? (
        <div className="hero-collapsed">
          <button title={t("side.showAvatar")} onClick={() => setAvatarCollapsed(false)}>
            ⌄ {t("side.showAvatar")}
          </button>
        </div>
      ) : (
        <>
          <SidebarAvatar
            onCollapse={() => setAvatarCollapsed(true)}
            style={
              avatarH !== null
                ? {
                    // 切换形象后旧高度可能低于新形象的 min（蜻蜓96/数字人170），渲染时按当前模式钳制。
                    height: Math.max(avatarH, avatarMin),
                    minHeight: Math.max(avatarH, avatarMin),
                    maxHeight: Math.max(avatarH, avatarMin),
                  }
                : undefined
            }
          />
          <Splitter orientation="row" label={t("side.splitAvatar")} onDrag={dragAvatar} onReset={() => setAvatarH(null)} />
        </>
      )}

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

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} />}
      {shareTarget && (
        <ShareDialog
          session={sessions.find((s) => s.session_id === shareTarget)!}
          onClose={() => setShareTarget(null)}
        />
      )}

      <div>
        <SidebarFooter />
      </div>
    </aside>
  );
}
