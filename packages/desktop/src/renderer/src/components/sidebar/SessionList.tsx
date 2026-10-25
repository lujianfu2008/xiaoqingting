import { useEffect, useState } from "react";
import type { ProjectMeta, SessionMeta } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

// My sessions grouped by project (default space last), then shared (read-only)
// sessions. The share/delete buttons live inside each row; both stop
// propagation so they don't select.

function SessionRow({
  s,
  active,
  onShare,
  onMoveMenu,
}: {
  s: SessionMeta;
  active: boolean;
  onShare: (sessionId: string) => void;
  onMoveMenu?: (sessionId: string, x: number, y: number) => void;
}): React.JSX.Element {
  const selectSession = useStore((sel) => sel.selectSession);
  const deleteSession = useStore((sel) => sel.deleteSession);
  const t = useT();
  return (
    <div
      className={`session-item ${active ? "active" : ""}`}
      onClick={() => void selectSession(s.session_id)}
      onContextMenu={
        onMoveMenu
          ? (e) => {
              e.preventDefault();
              onMoveMenu(s.session_id, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      <span className="title">{s.title}</span>
      <button
        className="del"
        title={
          s.shared
            ? s.shared_with?.length
              ? t("sess.sharedWith", { names: s.shared_with.join("、") })
              : t("sess.sharedAll")
            : t("sess.share")
        }
        style={s.shared ? { color: "#4aa3ff" } : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onShare(s.session_id);
        }}
      >
        ❐
      </button>
      <button
        className="del"
        title={t("sess.del")}
        onClick={(e) => {
          e.stopPropagation();
          void deleteSession(s.session_id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

const groupHeaderStyle = {
  margin: "10px 0 2px",
  fontSize: 12,
  color: "var(--muted)",
  padding: "0 8px",
} as const;

function ProjectGroup({
  project,
  sessions,
  onShare,
  onMoveMenu,
  onSettings,
}: {
  project: ProjectMeta;
  sessions: SessionMeta[];
  onShare: (sessionId: string) => void;
  onMoveMenu?: (sessionId: string, x: number, y: number) => void;
  onSettings: () => void;
}): React.JSX.Element {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const newSession = useStore((s) => s.newSession);
  const deleteProject = useStore((s) => s.deleteProject);
  const role = useStore((s) => s.role);
  const t = useT();
  const isPublic = project.visibility === "public";

  // undefined = not queried yet; null = unbound on this machine.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (isPublic) return; // 公有域项目没有本机文件夹绑定
    let alive = true;
    void window.blm.getProjectFolder(project.project_id).then((r) => {
      if (alive) setFolder(r.folder);
    });
    return () => {
      alive = false;
    };
  }, [isPublic, project.project_id]);

  const bindFolder = (): void => {
    void window.blm
      .bindProjectFolder(project.project_id, { name: project.name, choose: true })
      .then((r) => {
        if (r.ok) setFolder(r.folder ?? null);
      });
  };

  return (
    <>
      <div style={{ ...groupHeaderStyle, display: "flex", alignItems: "center", gap: 4 }}>
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={
            isPublic
              ? t("proj.publicTip", { owner: project.owner ?? "" })
              : folder
                ? t("proj.spaceTip", { folder })
                : t("proj.unboundTip")
          }
        >
          {isPublic ? "🌐" : "📁"} {project.name}
          {!isPublic && folder === null && (
            <span style={{ color: "#e5a83a" }}>{t("proj.unbound")}</span>
          )}
        </span>
        {!isPublic && (
          <button
            className="del"
            title={folder ? t("proj.rebind") : t("proj.bind")}
            onClick={bindFolder}
          >
            📁
          </button>
        )}
        <button className="del" title={t("proj.settings")} onClick={onSettings}>
          ⚙
        </button>
        <button
          className="del"
          title={t("proj.newSession", { name: project.name })}
          onClick={() => void newSession(project.agent_id, project.project_id)}
        >
          ＋
        </button>
        {(role === "admin" || !isPublic) && (
          <button
            className="del"
            title={isPublic ? t("proj.deletePublic") : t("proj.delete")}
            onClick={() => {
              const tip = isPublic
                ? t("proj.deletePublicConfirm", { name: project.name })
                : t("proj.deleteConfirm", { name: project.name });
              if (window.confirm(tip)) {
                void deleteProject(project.project_id);
              }
            }}
          >
            ✕
          </button>
        )}
      </div>
      {sessions.map((s) => (
        <SessionRow
          key={s.session_id}
          s={s}
          active={s.session_id === currentSessionId && !sharedView}
          onShare={onShare}
          onMoveMenu={onMoveMenu}
        />
      ))}
    </>
  );
}

export function SessionList({
  onShare,
  onNewProject,
}: {
  onShare: (sessionId: string) => void;
  onNewProject: () => void;
}): React.JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const sharedSessions = useStore((s) => s.sharedSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sharedView = useStore((s) => s.sharedView);
  const selectSharedSession = useStore((s) => s.selectSharedSession);
  const presence = useStore((s) => s.presence);
  const moveSession = useStore((s) => s.moveSession);
  const t = useT();

  // Right-click "move to project" menu state (viewport coords).
  const [moveMenu, setMoveMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  // Which project's settings dialog is open (null = none).
  const [settingsFor, setSettingsFor] = useState<ProjectMeta | null>(null);

  // 公有域项目单独分区展示（工作空间在服务端，而非本机文件夹）。
  const personalProjects = projects.filter((p) => p.visibility !== "public");
  const publicProjects = projects.filter((p) => p.visibility === "public");

  const byProject = new Map<string, SessionMeta[]>();
  const def: SessionMeta[] = [];
  const known = new Set(projects.map((p) => p.project_id));
  for (const s of sessions) {
    if (s.project_id && known.has(s.project_id)) {
      const arr = byProject.get(s.project_id) ?? [];
      arr.push(s);
      byProject.set(s.project_id, arr);
    } else {
      def.push(s); // default space, incl. orphaned project ids
    }
  }

  const menuSession = moveMenu
    ? sessions.find((s) => s.session_id === moveMenu.sessionId)
    : undefined;
  // 移动目标只允许同 visibility（个人↔公域禁止互移，服务端也会拒绝）。
  const menuIsPublic = menuSession?.project_id
    ? projects.find((p) => p.project_id === menuSession.project_id)?.visibility === "public"
    : false;

  return (
    <>
      {personalProjects.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
        />
      ))}

      {publicProjects.length > 0 && (
        <div style={groupHeaderStyle}>{t("proj.publicSection")}</div>
      )}
      {publicProjects.map((p) => (
        <ProjectGroup
          key={p.project_id}
          project={p}
          sessions={byProject.get(p.project_id) ?? []}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
          onSettings={() => setSettingsFor(p)}
        />
      ))}

      {/* New-project entry lives below the project groups, not next to 新对话 —
          the row-level ＋ buttons mean "new session in this project" and must
          not be confused with creating a project. */}
      <button
        title={t("proj.newProjectTip")}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: groupHeaderStyle.padding,
          margin: "2px 0 0",
          fontSize: 12,
          color: "var(--muted)",
          background: "none",
          border: "none",
          cursor: "pointer",
        }}
        onClick={onNewProject}
      >
        {t("proj.newProject")}
      </button>

      {def.length > 0 && <div style={groupHeaderStyle}>{t("sess.defaultSpace")}</div>}
      {def.map((s) => (
        <SessionRow
          key={s.session_id}
          s={s}
          active={s.session_id === currentSessionId && !sharedView}
          onShare={onShare}
          onMoveMenu={(id, x, y) => setMoveMenu({ sessionId: id, x, y })}
        />
      ))}

      {sharedSessions.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", padding: "0 8px" }}>
          {t("sess.sharedHeader")}
        </div>
      )}
      {sharedSessions.map((s) => {
        const online = s.owner ? (presence[s.owner] ?? s.owner_online ?? false) : false;
        return (
          <div
            key={s.session_id}
            className={`session-item ${s.session_id === currentSessionId && sharedView ? "active" : ""}`}
            title={t("sess.viewTip", { owner: s.owner ?? "", online: online ? t("chat.ownerOnline") : t("chat.ownerOffline") })}
            onClick={() => void selectSharedSession(s.session_id)}
          >
            <span className="title">
              {s.owner} / {s.title}
            </span>
            <span
              className={`status-dot ${online ? "ok" : "bad"}`}
              title={online ? t("chat.ownerOnline") : t("chat.ownerOffline")}
            />
            {!online && <span className="offline-tip">{t("sess.offline")}</span>}
          </div>
        );
      })}

      {/* Right-click menu: move one of my sessions into another project (or
          back to the default space). Click-anywhere overlay closes it. */}
      {settingsFor && (
        <ProjectSettingsDialog project={settingsFor} onClose={() => setSettingsFor(null)} />
      )}

      {moveMenu && menuSession && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000 }}
          onClick={() => setMoveMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMoveMenu(null);
          }}
        >
          <div
            style={{
              position: "fixed",
              left: Math.min(moveMenu.x, window.innerWidth - 190),
              top: Math.min(moveMenu.y, window.innerHeight - 240),
              minWidth: 170,
              maxHeight: 220,
              overflowY: "auto",
              background: "var(--panel, #fff)",
              border: "1px solid var(--border, #ddd)",
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,.18)",
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 8px" }}>
              {t("move.title", {
                title:
                  menuSession.title.length > 12
                    ? `${menuSession.title.slice(0, 12)}…`
                    : menuSession.title,
              })}
            </div>
            {projects
              .filter((p) => (p.visibility === "public") === menuIsPublic)
              .filter((p) => p.project_id !== (menuSession.project_id ?? null))
              .map((p) => (
                <button
                  key={p.project_id}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    fontSize: 12,
                    padding: "5px 8px",
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    void moveSession(menuSession.session_id, p.project_id);
                    setMoveMenu(null);
                  }}
                >
                  📁 {p.name}
                </button>
              ))}
            {menuSession.project_id && !menuIsPublic && (
              <button
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  fontSize: 12,
                  padding: "5px 8px",
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                }}
                onClick={() => {
                  void moveSession(menuSession.session_id, null);
                  setMoveMenu(null);
                }}
              >
                {t("move.default")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
