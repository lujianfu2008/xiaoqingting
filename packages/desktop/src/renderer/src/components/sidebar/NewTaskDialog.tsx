import { useEffect, useState } from "react";
import type { ProjectMeta, WorkflowStage } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { Overlay } from "../Overlay";
import { UserPickerDialog } from "../UserPickerDialog";

// 新建协作任务（可自定义工作流的起点）：标题 + 需求描述 + 环节来源 +
// 逐环节负责人（预置带出，可改可清空）。成功后切进绑定会话并把描述
// 预填输入框——需求方点发送即启动 agent 分析。
// 环节来源：project（协作项目组内入口）→ 项目级环节链（template_name
// 记项目名）；无 project 时选所属协作项目（可选默认空间 → 模板库）。
export function NewTaskDialog({
  project,
  onClose,
}: {
  project?: ProjectMeta;
  onClose: () => void;
}): React.JSX.Element {
  const createTask = useStore((s) => s.createTask);
  const selectSession = useStore((s) => s.selectSession);
  const setDraft = useStore((s) => s.setDraft);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const workflows = useStore((s) => s.workflows);
  const projects = useStore((s) => s.projects);
  const [projId, setProjId] = useState<string>(""); // 全局入口：所属协作项目（"" = 默认空间）
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [tplName, setTplName] = useState<string>(""); // 空 = 用列表首个（内置恒在首位）
  // stage_key → 显式负责人（空串 = 清空预置）；未提及的环节用预置。
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [pickStage, setPickStage] = useState<WorkflowStage | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // 生效环节来源：项目 prop 优先；否则按所选项目（须 collab）。
  const targetProject = project ?? projects.find((p) => p.project_id === projId);
  const projectStages =
    targetProject && (targetProject.kind ?? "standard") === "collab"
      ? targetProject.workflow?.stages ?? null
      : null;

  const list = workflows ?? [];
  const tpl = list.find((w) => w.name === (tplName || list[0]?.name)) ?? list[0];
  // 环节链：项目级优先；无项目环节时回落模板。
  const stages: WorkflowStage[] = projectStages ?? tpl?.stages ?? [];
  const effective = (s: WorkflowStage): string | undefined =>
    s.key in assignees ? assignees[s.key] || undefined : s.assignee;

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const task = await createTask({
      title: trimmed,
      ...(desc.trim() ? { description: desc.trim() } : {}),
      // 项目级环节：server 端按 project.workflow 快照；模板库：带模板名。
      ...(projectStages
        ? { project_id: targetProject!.project_id }
        : tpl
          ? { template_name: tpl.name }
          : {}),
      ...(Object.keys(assignees).length > 0
        ? { assignees: Object.fromEntries(Object.entries(assignees)) }
        : {}),
    });
    setBusy(false);
    if (!task) {
      useStore.setState({ error: t("task.createFail") });
      return;
    }
    onClose();
    // 切进任务线程；描述预填输入框（用户确认/补改后点发送即开始分析）。
    void selectSession(task.session_id);
    if (desc.trim()) setDraft(desc.trim());
  };

  // 全局入口的所属协作项目列表（本人 collab 项目）。
  const myCollabProjects = projects.filter((p) => p.kind === "collab");

  return (
    <Overlay onClose={onClose}>
      <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2>{t("task.newTitle")}</h2>
        {/* 中段整体可滚动：选项多时底部按钮不被挤出视口。 */}
        <div className="dialog-scroll" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="field">
          <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.titleLabel")}</label>
          <input
            autoFocus
            value={title}
            maxLength={100}
            placeholder={t("task.titlePh")}
            style={{ width: "100%", marginTop: 4 }}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.descLabel")}</label>
          <textarea
            value={desc}
            maxLength={8000}
            placeholder={t("task.descPh")}
            style={{ width: "100%", minHeight: 120, marginTop: 4 }}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        {!project && myCollabProjects.length > 0 && (
          <div className="field" style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.projectLabel")}</label>
            <select
              value={projId}
              style={{ width: "100%", marginTop: 4 }}
              onChange={(e) => {
                setProjId(e.target.value);
                setAssignees({}); // 换环节来源重置为预置
              }}
            >
              <option value="">{t("task.projectDefault")}</option>
              {myCollabProjects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {!projectStages && list.length > 0 && tpl && (
          <>
            <div className="field" style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.templateLabel")}</label>
              <select
                value={tpl.name}
                style={{ width: "100%", marginTop: 4 }}
                onChange={(e) => {
                  setTplName(e.target.value);
                  setAssignees({}); // 换模板重置为该模板预置
                }}
              >
                {list.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name}
                    {w.source === "built_in" ? `（${t("wf.builtInTag")}）` : ""}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        {projectStages && (
          <div className="field" style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.templateLabel")}</label>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {t("task.projectStages", { name: targetProject!.name })}
            </div>
          </div>
        )}
        {stages.length > 0 && (
          <div className="field" style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>{t("task.assigneesLabel")}</label>
            <div
              style={{
                marginTop: 4,
                border: "1px solid var(--border, #444)",
                borderRadius: 6,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {stages.map((s, i) => {
                const a = effective(s);
                return (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {i + 1}. {s.name}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {a ?? <span style={{ color: "var(--muted)" }}>{t("task.stageUnassigned")}</span>}
                    </span>
                    <button style={{ fontSize: 11 }} onClick={() => setPickStage(s)}>
                      {t("wf.stagePick")}
                    </button>
                    {a && (
                      <button
                        className="del"
                        style={{ fontSize: 11 }}
                        onClick={() => setAssignees((m) => ({ ...m, [s.key]: "" }))}
                      >
                        {t("wf.stageClear")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </div>
        <div className="actions">
          <button onClick={onClose}>{t("np.cancel")}</button>
          <button className="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {t("task.create")}
          </button>
        </div>
      </div>
      {pickStage && (
        <UserPickerDialog
          title={t("task.assignStagePick", { stage: pickStage.name })}
          includeSelf
          onPick={(user) => {
            if (user) setAssignees((m) => ({ ...m, [pickStage.key]: user }));
          }}
          onClose={() => setPickStage(null)}
        />
      )}
    </Overlay>
  );
}
