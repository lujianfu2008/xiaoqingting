import { useEffect, useState } from "react";
import type { ProjectMeta } from "@blm/protocol";
import { useT } from "../../i18n";

type ScopeMode = AccessScopeState["mode"];

// Per-project settings, reachable any time from the sidebar ⚙ (not just at
// creation): the bound local folder and the read-scope override. The override
// lives in the main process settings.json; null means "follow the global
// scope". Custom extra folders are a global list — shown read-only here.
// 公有域项目没有本机文件夹/读取范围，只显示说明信息。
export function ProjectSettingsDialog({
  project,
  onClose,
}: {
  project: ProjectMeta;
  onClose: () => void;
}): React.JSX.Element {
  const isPublic = project.visibility === "public";
  // undefined = not queried yet; null = unbound on this machine.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [choice, setChoice] = useState<"global" | ScopeMode>("global");
  const [globalMode, setGlobalMode] = useState<ScopeMode>("workspace");
  const [folders, setFolders] = useState<string[]>([]);
  const t = useT();

  useEffect(() => {
    if (isPublic) return; // 公有域项目不查/不改本机绑定
    let alive = true;
    void window.blm.getProjectFolder(project.project_id).then((r) => {
      if (alive) setFolder(r.folder);
    });
    void window.blm.accessScope.get(project.project_id).then((s) => {
      if (!alive) return;
      setGlobalMode(s.mode);
      setFolders(s.folders);
      setChoice(s.projectMode ?? "global");
    });
    return () => {
      alive = false;
    };
  }, [isPublic, project.project_id]);

  const setScope = (v: "global" | ScopeMode): void => {
    setChoice(v); // optimistic; the IPC answer is authoritative for folders
    void window.blm
      .accessScope.setProjectMode(project.project_id, v === "global" ? null : v)
      .then((s) => {
        setGlobalMode(s.mode);
        setFolders(s.folders);
      });
  };

  const changeFolder = (): void => {
    void window.blm
      .bindProjectFolder(project.project_id, { name: project.name, choose: true })
      .then((r) => {
        if (r.ok) setFolder(r.folder ?? null);
      });
  };

  const modeLabel = (m: ScopeMode): string =>
    t(m === "workspace" ? "np.scopeWs" : m === "full" ? "np.scopeFull" : "np.scopeCustom");
  const modeHint = (m: ScopeMode): string =>
    t(m === "workspace" ? "gen.modeWsHint" : m === "full" ? "gen.modeFullHint" : "gen.modeCustomHint");

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2>
          {isPublic
            ? t("pset.publicTitle", { name: project.name })
            : t("pset.title", { name: project.name })}
        </h2>

        {isPublic ? (
          <>
            <div className="field">
              <label>{t("pset.publicInfo")}</label>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {t("pset.publicOwner", { owner: project.owner ?? "" })}
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{t("pset.publicHint")}</div>
          </>
        ) : (
          <>
            <div className="field">
              <label>{t("np.folder")}</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  title={folder ?? undefined}
                  style={{ flex: 1, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}
                >
                  {folder ?? t("proj.unbound")}
                </span>
                <button style={{ fontSize: 12 }} onClick={changeFolder}>
                  {t("gen.change")}
                </button>
              </div>
              {folder === null && (
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  {t("pset.unboundHint")}
                </div>
              )}
            </div>

            <div className="field">
              <label>{t("np.scope")}</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="project-scope"
                    checked={choice === "global"}
                    onChange={() => setScope("global")}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ fontSize: 12 }}>
                      {t("pset.follow", { mode: modeLabel(globalMode) })}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                      {modeHint(globalMode)}
                    </span>
                  </span>
                </label>
                {(["workspace", "full", "custom"] as const).map((m) => (
                  <label key={m} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="project-scope"
                      checked={choice === m}
                      onChange={() => setScope(m)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <span style={{ fontSize: 12 }}>{modeLabel(m)}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                        {modeHint(m)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {choice === "custom" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                    {t("pset.customFolders")}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {folders.map((f) => (
                      <span
                        key={f}
                        title={f}
                        style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}
                      >
                        • {f}
                      </span>
                    ))}
                    {folders.length === 0 && (
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("gen.noFolders")}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                    {t("pset.customFoldersHint")}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                {t("pset.hint")}
              </div>
            </div>
          </>
        )}

        <div className="actions">
          <button className="primary" onClick={onClose}>
            {t("set.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
