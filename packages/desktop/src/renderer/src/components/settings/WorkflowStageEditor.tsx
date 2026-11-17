import { useState } from "react";
import type { WorkflowStage } from "@blm/protocol";
import { useT } from "../../i18n";
import { UserPickerDialog } from "../UserPickerDialog";

// 工作流环节链编辑器（纯受控组件）：环节增删/上移下移/改名/预置负责人。
// 供工作流模板编辑器与协作项目设置复用；快照语义见 TaskManager.createTask。

export function WorkflowStageEditor({
  stages,
  onChange,
}: {
  stages: WorkflowStage[];
  onChange: (stages: WorkflowStage[]) => void;
}): React.JSX.Element {
  const t = useT();
  const [pickIdx, setPickIdx] = useState<number | null>(null);

  const patchStage = (i: number, patch: Partial<WorkflowStage>): void => {
    onChange(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    const copy = [...stages];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{t("wf.stagesLabel")}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {stages.map((s, i) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--muted)", width: 18 }}>{i + 1}.</span>
            <input
              value={s.name}
              maxLength={40}
              placeholder={t("wf.stageNamePh")}
              style={{ flex: 1, fontSize: 12 }}
              onChange={(e) => patchStage(i, { name: e.target.value })}
            />
            <span style={{ fontSize: 11, color: "var(--muted)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.assignee ?? t("task.stageUnassigned")}
            </span>
            <button style={{ fontSize: 11, padding: "1px 6px" }} onClick={() => setPickIdx(i)}>
              {t("wf.stagePick")}
            </button>
            {s.assignee && (
              <button
                className="del"
                style={{ fontSize: 11, padding: "1px 6px" }}
                onClick={() => patchStage(i, { assignee: undefined })}
              >
                {t("wf.stageClear")}
              </button>
            )}
            <button style={{ fontSize: 11, padding: "1px 5px" }} disabled={i === 0} onClick={() => move(i, -1)} title="↑">↑</button>
            <button style={{ fontSize: 11, padding: "1px 5px" }} disabled={i === stages.length - 1} onClick={() => move(i, 1)} title="↓">↓</button>
            <button
              className="del"
              style={{ fontSize: 11, padding: "1px 5px" }}
              disabled={stages.length <= 1}
              onClick={() => onChange(stages.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        style={{ fontSize: 11, marginTop: 6, alignSelf: "flex-start" }}
        disabled={stages.length >= 12}
        onClick={() => onChange([...stages, { key: crypto.randomUUID(), name: "" }])}
      >
        {t("wf.addStage")}
      </button>
      {pickIdx !== null && (
        <UserPickerDialog
          title={t("task.assignStagePick", { stage: stages[pickIdx]?.name ?? "" })}
          includeSelf
          onPick={(user) => {
            if (user) patchStage(pickIdx, { assignee: user });
          }}
          onClose={() => setPickIdx(null)}
        />
      )}
    </div>
  );
}
