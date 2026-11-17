import { useEffect, useState } from "react";
import type { ProjectMeta, WorkflowStage } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { WorkflowStageEditor } from "../settings/WorkflowStageEditor";
import { ScheduleForm, timeToText } from "../settings/ScheduleForm";

type ScopeMode = AccessScopeState["mode"];

// Per-project settings, reachable any time from the sidebar ⚙ (not just at
// creation): the project description (injected into every session's agent
// context), the bound local folder and the read-scope override. The override
// lives in the main process settings.json; null means "follow the global
// scope". Custom extra folders are a global list — shown read-only here.
// 公有域项目没有本机文件夹/读取范围，只显示说明信息；描述仅管理员可改。
// 协作项目多一个环节链编辑器；定时任务项目多一个定时任务列表/表单。
export function ProjectSettingsDialog({
  project,
  onClose,
}: {
  project: ProjectMeta;
  onClose: () => void;
}): React.JSX.Element {
  const isPublic = project.visibility === "public";
  const kind = project.kind ?? "standard";
  const role = useStore((s) => s.role);
  const updateProjectDescription = useStore((s) => s.updateProjectDescription);
  const updateProjectWorkflow = useStore((s) => s.updateProjectWorkflow);
  const schedules = useStore((s) => s.schedules);
  const trigger = useStore((s) => s.triggerSchedule);
  const toggle = useStore((s) => s.setScheduleEnabled);
  const remove = useStore((s) => s.deleteSchedule);
  const selectSession = useStore((s) => s.selectSession);
  // undefined = not queried yet; null = unbound on this machine.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [choice, setChoice] = useState<"global" | ScopeMode>("global");
  const [globalMode, setGlobalMode] = useState<ScopeMode>("workspace");
  const [folders, setFolders] = useState<string[]>([]);
  // 描述编辑（本地暂存，保存走 REST）。
  const [desc, setDesc] = useState(project.description ?? "");
  const [descBusy, setDescBusy] = useState(false);
  const [descMsg, setDescMsg] = useState<null | "ok" | "fail">(null);
  // 协作项目：环节链本地暂存（保存走 POST /workflow）。
  const [stages, setStages] = useState<WorkflowStage[]>(
    project.workflow?.stages ?? [],
  );
  const [wfMsg, setWfMsg] = useState<null | "ok" | "fail">(null);
  const [wfBusy, setWfBusy] = useState(false);
  // 定时任务项目：内联新建表单开关。
  const [schedAdding, setSchedAdding] = useState(false);
  const t = useT();

  const canEditDesc = !isPublic || role === "admin";

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

  const saveDescription = (): void => {
    if (descBusy) return;
    setDescBusy(true);
    setDescMsg(null);
    void updateProjectDescription(project.project_id, desc.trim())
      .then((ok) => setDescMsg(ok ? "ok" : "fail"))
      .finally(() => setDescBusy(false));
  };

  const saveWorkflow = (): void => {
    if (wfBusy) return;
    const named = stages.filter((s) => s.name.trim());
    if (named.length === 0 || named.length !== stages.length) return;
    setWfBusy(true);
    setWfMsg(null);
    void updateProjectWorkflow(project.project_id, stages)
      .then((ok) => setWfMsg(ok ? "ok" : "fail"))
      .finally(() => setWfBusy(false));
  };

  const projSchedules = schedules.filter((r) => r.project_id === project.project_id);

  const runNow = async (id: string): Promise<void> => {
    void trigger(id);
  };

  const doRemove = (rec: { schedule_id: string; name: string }): void => {
    if (window.confirm(t("sc.deleteConfirm", { name: rec.name }))) {
      void remove(rec.schedule_id);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2>
          {isPublic
            ? t("pset.publicTitle", { name: project.name })
            : t("pset.title", { name: project.name })}
        </h2>

        {/* 中段整体可滚动：选项多时底部按钮不被挤出视口。 */}
        <div className="dialog-scroll" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 项目描述：随会话注入智能体上下文；个人/公域管理员可编辑，公域成员只读。 */}
        <div className="field">
          <label>{t("pset.descLabel")}</label>
          {canEditDesc ? (
            <>
              <textarea
                value={desc}
                maxLength={500}
                rows={3}
                placeholder={t("pset.descPh")}
                style={{ width: "100%", resize: "vertical" }}
                onChange={(e) => {
                  setDesc(e.target.value);
                  setDescMsg(null);
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <button style={{ fontSize: 12 }} disabled={descBusy} onClick={saveDescription}>
                  {t("pset.descSave")}
                </button>
                {descMsg === "ok" && (
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("pset.descSaved")}</span>
                )}
                {descMsg === "fail" && (
                  <span style={{ fontSize: 11, color: "var(--danger)" }}>{t("pset.descSaveFail")}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {t("pset.descHint")}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap" }}>
                {project.description || t("pset.descNone")}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {t("proj.descReadOnly")}
              </div>
            </>
          )}
        </div>

        {/* 协作项目：环节链编辑器（保存只影响之后新建的任务）。 */}
        {kind === "collab" && (
          <div className="field">
            <label>{t("pset.workflowLabel")}</label>
            <WorkflowStageEditor stages={stages} onChange={setStages} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <button
                style={{ fontSize: 12 }}
                disabled={wfBusy || stages.some((s) => !s.name.trim())}
                onClick={saveWorkflow}
              >
                {t("pset.workflowSave")}
              </button>
              {wfMsg === "ok" && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("pset.workflowSaved")}</span>
              )}
              {wfMsg === "fail" && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>{t("pset.workflowSaveFail")}</span>
              )}
            </div>
          </div>
        )}

        {/* 定时任务项目：该项目定时任务列表 + 内联新建表单。 */}
        {kind === "scheduled" && (
          <div className="field">
            <label>
              {t("pset.schedulesLabel")}
              {projSchedules.length > 0 && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}> · {projSchedules.length}</span>
              )}
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {projSchedules.length === 0 && !schedAdding && (
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{t("sc.empty")}</div>
              )}
              {projSchedules.map((rec) => (
                <div
                  key={rec.schedule_id}
                  style={{
                    border: "1px solid var(--border, #ccc)",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontSize: 12,
                    opacity: rec.enabled ? 1 : 0.6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <strong>{rec.name}</strong>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>
                      {timeToText(rec.time, t)}
                    </span>
                    <button
                      style={{ fontSize: 11, padding: "1px 8px" }}
                      onClick={() => void runNow(rec.schedule_id)}
                    >
                      {t("sc.runNow")}
                    </button>
                    <button
                      style={{ fontSize: 11, padding: "1px 8px" }}
                      onClick={() => void toggle(rec.schedule_id, !rec.enabled)}
                    >
                      {rec.enabled ? "⏸" : "▶"}
                    </button>
                    {rec.session_id && (
                      <button
                        style={{ fontSize: 11, padding: "1px 8px" }}
                        onClick={() => {
                          onClose();
                          void selectSession(rec.session_id!);
                        }}
                      >
                        {t("sc.openSession")}
                      </button>
                    )}
                    <button className="del" style={{ fontSize: 11, padding: "1px 8px" }} onClick={() => doRemove(rec)}>
                      {t("sc.delete")}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                    {rec.next_run_at
                      ? t("sc.nextRun", { time: new Date(rec.next_run_at).toLocaleString() })
                      : t("sc.neverRun")}
                  </div>
                </div>
              ))}
              {schedAdding ? (
                <ScheduleForm
                  initial={null}
                  projectPreset={{ project_id: project.project_id, agentId: project.agent_id }}
                  onDone={() => setSchedAdding(false)}
                />
              ) : (
                <button style={{ fontSize: 11, alignSelf: "flex-start" }} onClick={() => setSchedAdding(true)}>
                  {t("sc.add")}
                </button>
              )}
            </div>
          </div>
        )}

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
