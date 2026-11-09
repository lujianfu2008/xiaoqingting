import { useEffect, useState } from "react";
import type { WorkflowInfo, WorkflowStage } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { UserPickerDialog } from "../UserPickerDialog";

// 工作流模板设置面板：合并列表（内置 + 全局 + 我的，同名我的覆盖全局）、
// 模板编辑器（环节增删/排序/改名/预置负责人）。与 SkillsPanel 同构：
// 仅管理员见全局区块；内置「标准流程」只读；模板名即主键（改名 = 新建）。

type Scope = "user" | "global";

interface EditorState {
  name: string;
  description: string;
  stages: WorkflowStage[];
}

// ---------- 模板编辑器（新增或编辑；保存按名字 PUT，改名 = 新建） ----------

function WorkflowForm({
  scope,
  initial,
  onDone,
}: {
  scope: Scope;
  initial: WorkflowInfo | null;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const save = useStore((s) => (scope === "global" ? s.saveGlobalWorkflow : s.saveWorkflow));
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [stages, setStages] = useState<WorkflowStage[]>(
    initial?.stages ?? [{ key: crypto.randomUUID(), name: "" }],
  );
  const [pickIdx, setPickIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patchStage = (i: number, patch: Partial<WorkflowStage>): void => {
    setStages((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const move = (i: number, dir: -1 | 1): void => {
    setStages((ss) => {
      const j = i + dir;
      if (j < 0 || j >= ss.length) return ss;
      const copy = [...ss];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };

  const submit = async (): Promise<void> => {
    setErr(null);
    const trimmed = name.trim();
    const named = stages.filter((s) => s.name.trim());
    if (!trimmed) {
      setErr(t("wf.errName"));
      return;
    }
    if (named.length === 0 || named.length !== stages.length || stages.length > 12) {
      setErr(t("wf.errStage"));
      return;
    }
    setBusy(true);
    try {
      await save(
        trimmed,
        {
          ...(description.trim() ? { description: description.trim() } : {}),
          stages: stages.map((s) => ({
            key: s.key,
            name: s.name.trim(),
            ...(s.assignee ? { assignee: s.assignee } : {}),
          })),
        },
      );
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("wf.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border, #ccc)",
        borderRadius: 6,
        padding: 10,
        margin: "8px 0",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("wf.name")}</label>
        <input
          value={name}
          maxLength={60}
          disabled={!!initial} // 模板名即主键；改名 = 新建一个再删旧的
          onChange={(e) => setName(e.target.value)}
          placeholder={t("wf.namePh")}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("wf.descLabel")}</label>
        <input
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
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
                onClick={() => setStages((ss) => ss.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          style={{ fontSize: 11, marginTop: 6, alignSelf: "flex-start" }}
          disabled={stages.length >= 12}
          onClick={() => setStages((ss) => [...ss, { key: crypto.randomUUID(), name: "" }])}
        >
          {t("wf.addStage")}
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => void submit()}>
          {t("wf.save")}
        </button>
        <button style={{ fontSize: 12 }} disabled={busy} onClick={onDone}>
          {t("wf.cancel")}
        </button>
      </div>
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

// ---------- 模板区块（列表 + 编辑/删除） ----------

function sourceTagKey(info: WorkflowInfo): "wf.builtInTag" | "wf.globalTag" | "wf.mineTag" {
  return info.source === "built_in" ? "wf.builtInTag" : info.source === "global" ? "wf.globalTag" : "wf.mineTag";
}

// 环节链预览：名→名→名（hover 显示各环节负责人）。
function StageChainPreview({ stages }: { stages: WorkflowStage[] }): React.JSX.Element {
  return (
    <span
      title={stages.map((s) => (s.assignee ? `${s.name}: ${s.assignee}` : s.name)).join(" → ")}
      style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all" }}
    >
      {stages.map((s) => s.name).join(" → ")}
    </span>
  );
}

function WorkflowSection({
  scope,
  title,
  entries,
  emptyText,
}: {
  scope: Scope;
  title: string;
  entries: WorkflowInfo[];
  emptyText: string;
}): React.JSX.Element {
  const t = useT();
  const remove = useStore((s) => (scope === "global" ? s.deleteGlobalWorkflow : s.deleteWorkflow));
  const [editing, setEditing] = useState<string | null>(null); // 模板名；"" = 新建
  const [err, setErr] = useState<string | null>(null);

  const doRemove = async (info: WorkflowInfo): Promise<void> => {
    if (!window.confirm(t("wf.deleteConfirm", { name: info.name }))) return;
    setErr(null);
    try {
      await remove(info.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("wf.saveFail"));
    }
  };

  const editingInfo = entries.find((w) => w.name === editing) ?? null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
        <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setEditing("")}>
          {t("wf.add")}
        </button>
      </div>

      {editing !== null && (
        <WorkflowForm scope={scope} initial={editingInfo} onDone={() => setEditing(null)} />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{emptyText}</div>
        )}
        {entries.map((info) => {
          const readonly = info.source === "built_in" || (scope === "user" && info.source === "global");
          return (
            <div
              key={`${info.source}:${info.name}`}
              style={{
                border: "1px solid var(--border, #ccc)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
                opacity: info.source === "built_in" ? 0.8 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong>{info.name}</strong>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{t(sourceTagKey(info))}</span>
                {info.overrides_global && (
                  <span style={{ fontSize: 10, color: "var(--accent)" }}>{t("wf.overrideTag")}</span>
                )}
                <span style={{ flex: 1 }} />
                {!readonly && (
                  <>
                    <button
                      style={{ fontSize: 11, padding: "1px 8px" }}
                      onClick={() => setEditing(info.name)}
                    >
                      {t("wf.edit")}
                    </button>
                    <button
                      className="del"
                      style={{ fontSize: 11, padding: "1px 8px" }}
                      onClick={() => void doRemove(info)}
                    >
                      {t("wf.delete")}
                    </button>
                  </>
                )}
              </div>
              {info.source === "built_in" && (
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                  {t("wf.builtInReadonly")}
                </div>
              )}
              {info.description && (
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{info.description}</div>
              )}
              <div style={{ marginTop: 2 }}>
                <StageChainPreview stages={info.stages} />
              </div>
            </div>
          );
        })}
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export function WorkflowsPanel(): React.JSX.Element {
  const t = useT();
  const role = useStore((s) => s.role);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const loadGlobalWorkflows = useStore((s) => s.loadGlobalWorkflows);
  const workflows = useStore((s) => s.workflows);
  const globalWorkflows = useStore((s) => s.globalWorkflows);
  const isAdmin = role === "admin";

  useEffect(() => {
    void loadWorkflows();
    if (isAdmin) void loadGlobalWorkflows();
    // 面板常驻挂载（settings 各 tab 均不卸载），仅按管理员身份拉取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 560 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {t("wf.note")}
      </div>
      <WorkflowSection
        scope="user"
        title={t("wf.listMine")}
        entries={workflows ?? []}
        emptyText={t("wf.empty")}
      />
      {isAdmin && (
        <>
          <div style={{ borderTop: "1px solid var(--border, #ccc)", margin: "4px 0 12px" }} />
          <WorkflowSection
            scope="global"
            title={t("wf.listGlobal")}
            entries={globalWorkflows ?? []}
            emptyText={t("wf.empty")}
          />
        </>
      )}
    </div>
  );
}
