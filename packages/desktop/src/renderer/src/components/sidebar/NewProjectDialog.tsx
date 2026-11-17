import { useState } from "react";
import type { ProjectKind, WorkflowStage } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { WorkflowStageEditor } from "../settings/WorkflowStageEditor";
import { ScheduleForm } from "../settings/ScheduleForm";

type ScopeMode = AccessScopeState["mode"];

// 内置「标准流程」的三环节（与 BUILT_IN_WORKFLOW 一致；仅作新建预填）。
const BUILT_IN_STAGES: WorkflowStage[] = [
  { key: "requirement", name: "需求分析" },
  { key: "dev", name: "研发" },
  { key: "test", name: "测试" },
];

// New-project dialog: name + one of the three agent roles + how to pick the
// local folder that becomes the project's independent space on this machine,
// plus the project's read-scope (defaults to following the global setting).
// 项目类型三选一：普通分类 / 协作任务（内嵌环节编辑器，可从模板导入预填）/
// 定时任务（内嵌定时任务表单，创建项目即挂首个定时任务）。
export function NewProjectDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const agents = useStore((s) => s.agents);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const createProject = useStore((s) => s.createProject);
  const createSchedule = useStore((s) => s.createSchedule);
  const loadSchedules = useStore((s) => s.loadSchedules);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const workflows = useStore((s) => s.workflows);
  const role = useStore((s) => s.role);

  const [kind, setKind] = useState<ProjectKind>("standard");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(currentAgentId);
  const [folder, setFolder] = useState<"auto" | "choose">("auto");
  // 公有域项目：存服务端工作空间，全员可查；仅管理员可创建。
  const [isPublic, setIsPublic] = useState(false);
  const [scope, setScope] = useState<"global" | ScopeMode>("global");
  // collab：环节编辑器（预填内置标准流程）+ 从模板导入。
  const [stages, setStages] = useState<WorkflowStage[]>(BUILT_IN_STAGES);
  // scheduled：内嵌表单仅在项目创建成功后出现（project_id 由创建结果回填）。
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const named = stages.filter((s) => s.name.trim());
    if (kind === "collab" && (named.length === 0 || named.length !== stages.length)) {
      setErr(t("wf.errStage"));
      setBusy(false);
      return;
    }
    const project = await createProject({
      name: name.trim(),
      description,
      agentId,
      folder: isPublic ? "auto" : folder,
      visibility: isPublic ? "public" : "personal",
      kind,
      workflow:
        kind === "collab"
          ? {
              stages: stages.map((s) => ({
                key: s.key,
                name: s.name.trim(),
                ...(s.assignee ? { assignee: s.assignee } : {}),
              })),
            }
          : undefined,
    });
    if (!project) {
      setBusy(false);
      setErr(t("np.fail"));
      return;
    }
    if (!isPublic && scope !== "global") {
      await window.blm.accessScope.setProjectMode(project.project_id, scope);
    }
    if (kind === "scheduled") {
      // 两步非事务：项目已建成，内嵌表单挂该项目的首个定时任务；
      // 用户可取消（项目保留，可在项目 ⚙ 设置里补建）。
      setCreatedProjectId(project.project_id);
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  };

  const kindOptions: { id: ProjectKind; label: string; hint: string }[] = [
    { id: "standard", label: t("np.kindStandard"), hint: t("np.kindStandardHint") },
    { id: "collab", label: t("np.kindCollab"), hint: t("np.kindCollabHint") },
    { id: "scheduled", label: t("np.kindScheduled"), hint: t("np.kindScheduledHint") },
  ];

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        {createdProjectId ? (
          // 定时任务项目第二步：为新建项目挂首个定时任务。
          <>
            <h2>{t("np.create")}: {name.trim()}</h2>
            <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 8px" }}>
              {t("np.kindScheduledHint")}
            </p>
            <div className="dialog-scroll">
            <ScheduleForm
              initial={null}
              projectPreset={{ project_id: createdProjectId, agentId }}
              onDone={() => {
                void loadSchedules();
                onClose();
              }}
            />
            </div>
          </>
        ) : (
          <>
            <h2>{t("np.title")}</h2>
            <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 12px" }}>
              {t("np.desc")}
            </p>

            {/* 中段整体可滚动：选项多时底部按钮不被挤出视口。 */}
            <div className="dialog-scroll" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field">
              <label>{t("np.kind")}</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {kindOptions.map((opt) => (
                  <label key={opt.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="project-kind"
                      checked={kind === opt.id}
                      onChange={() => setKind(opt.id)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <span style={{ fontSize: 12 }}>{opt.label}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="field">
              <label>{t("np.name")}</label>
              <input
                autoFocus
                value={name}
                placeholder={t("np.namePh")}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>

            <div className="field">
              <label>{t("np.descLabel")}</label>
              <textarea
                value={description}
                maxLength={500}
                rows={3}
                placeholder={t("np.descPh")}
                style={{ width: "100%", resize: "vertical" }}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {t("np.descHint")}
              </div>
            </div>

            <div className="field">
              <label>{t("np.agent")}</label>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name} — {a.description}
                  </option>
                ))}
                {agents.length === 0 && <option value={agentId}>{t("side.defaultAgent")}</option>}
              </select>
            </div>

            {kind === "collab" && (
              <div className="field">
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {t("np.fromTemplate")}
                  <select
                    style={{ fontSize: 12 }}
                    value=""
                    onChange={(e) => {
                      const tpl = (workflows ?? []).find((w) => w.name === e.target.value);
                      if (tpl) setStages(tpl.stages.map((s) => ({ ...s })));
                    }}
                  >
                    <option value="">{t("np.fromTemplatePh")}</option>
                    {(workflows ?? []).map((w) => (
                      <option key={w.name} value={w.name}>
                        {w.name}
                        {w.source === "built_in" ? `（${t("wf.builtInTag")}）` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ marginTop: 6 }}>
                  <WorkflowStageEditor stages={stages} onChange={setStages} />
                </div>
              </div>
            )}

            {role === "admin" && (
              <div className="field">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={isPublic}
                    onChange={(e) => setIsPublic(e.target.checked)}
                  />
                  {t("np.public")}
                </label>
                {isPublic && (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                    {t("np.publicTip")}
                  </div>
                )}
              </div>
            )}

            {!isPublic && (
            <>
            <div className="field">
              <label>{t("np.folder")}</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="radio"
                  checked={folder === "auto"}
                  onChange={() => setFolder("auto")}
                />
                {t("np.folderAuto")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <input
                  type="radio"
                  checked={folder === "choose"}
                  onChange={() => setFolder("choose")}
                />
                {t("np.folderChoose")}
              </label>
            </div>

            <div className="field">
              <label>{t("np.scope")}</label>
              <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="global">{t("np.scopeGlobal")}</option>
                <option value="workspace">{t("np.scopeWs")}</option>
                <option value="full">{t("np.scopeFull")}</option>
                <option value="custom">{t("np.scopeCustom")}</option>
              </select>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                {t("np.scopeHint")}
              </div>
            </div>
            </>
            )}

            {err && (
              <div style={{ color: "var(--danger)", fontSize: 12, margin: "0 0 8px" }}>{err}</div>
            )}
            </div>

            <div className="actions">
              <button onClick={onClose} disabled={busy}>
                {t("np.cancel")}
              </button>
              <button className="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
                {t("np.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
