import { useState } from "react";
import type { TaskView } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { executorOfTask } from "../../store/types";
import { UserPickerDialog } from "../UserPickerDialog";

// 协作流流程条（可自定义工作流模板）：环节胶囊链按任务快照动态渲染。挂在
// 会话顶部，仅当当前会话绑定了任务线程时渲染，普通会话零改动。按钮显隐按
// 服务端同一矩阵（执法在服务端）：当前环节负责人推进/打回/指派，需求方在
// 环节未指派时可推进，并可随时给任意环节指派换人或取消任务。

type PickKind =
  | { kind: "advance"; stageKey: string; stageName: string } // 推进时给下一环节补指派（可跳过）
  | { kind: "assign"; stageKey: string; stageName: string }; // 指派/换人

// 环节胶囊链：已过实色 → 当前高亮蓝 → 未到灰，尾接「已完成/已取消」。
function StageChain({ task }: { task: TaskView }): React.JSX.Element {
  const t = useT();
  const curIdx = task.current_stage
    ? task.stages.findIndex((s) => s.key === task.current_stage)
    : -1;
  const finished = task.status === "done";
  const pill = (label: string, state: "done" | "active" | "todo"): React.JSX.Element => (
    <span
      style={{
        fontSize: 11,
        padding: "1px 8px",
        borderRadius: 999,
        border: `1px solid ${state === "active" ? "#4aa3ff" : "var(--border, #444)"}`,
        background:
          state === "active"
            ? "rgba(74,163,255,.15)"
            : state === "done"
              ? "rgba(74,163,255,.08)"
              : "transparent",
        color: state === "todo" ? "var(--muted)" : state === "active" ? "#4aa3ff" : "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      {task.stages.map((s, i) => (
        <span key={s.key} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {i > 0 && <span style={{ color: "var(--muted)", fontSize: 10 }}>→</span>}
          <span title={s.assignee ? `${s.name}: ${s.assignee}` : s.name}>
            {pill(s.name, finished ? "done" : i === curIdx ? "active" : i < curIdx ? "done" : "todo")}
          </span>
        </span>
      ))}
      <span style={{ color: "var(--muted)", fontSize: 10 }}>→</span>
      {pill(task.cancelled ? t("task.statusCancelled") : t("task.statusDone"), "done")}
    </span>
  );
}

function RoleLine({ task }: { task: TaskView }): React.JSX.Element {
  const t = useT();
  const presence = useStore((s) => s.presence);
  const executor = executorOfTask(task);
  const role = (label: string, user: string | undefined): React.JSX.Element => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        className={`status-dot ${user && (presence[user] ?? false) ? "ok" : "bad"}`}
        title={user && (presence[user] ?? false) ? t("sh.online") : t("sess.offline")}
      />
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span>{user ?? "—"}</span>
    </span>
  );
  return (
    <span style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      {role(t("task.roleRequester"), task.requester)}
      {task.status === "active" && role(t("task.roleExecutor"), executor)}
    </span>
  );
}

export function FlowBar({ task }: { task: TaskView }): React.JSX.Element {
  const t = useT();
  const me = useStore((s) => s.username);
  const flowTask = useStore((s) => s.flowTask);
  const executor = executorOfTask(task);
  const executorOnline = useStore((s) => s.presence[executor] ?? false);
  const [pick, setPick] = useState<PickKind | null>(null);
  const [backOpen, setBackOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [backNote, setBackNote] = useState("");
  const [descOpen, setDescOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };

  const isRequester = me === task.requester;
  const active = task.status === "active";
  const curIdx = task.current_stage
    ? task.stages.findIndex((s) => s.key === task.current_stage)
    : -1;
  const cur = curIdx >= 0 ? task.stages[curIdx] : null;
  const next = curIdx >= 0 ? task.stages[curIdx + 1] : undefined;
  // 与服务端矩阵同规则：已设负责人的环节只有负责人能动；未设环节需求方兜底。
  const canAdvance =
    active && cur != null && (cur.assignee ? cur.assignee === me : isRequester);
  const canSendBack = active && canAdvance && curIdx > 0;
  const canAssign = active && cur != null && (isRequester || cur.assignee === me);

  // 推进：下一环节无人时先弹选人（可跳过 = 不指派，该环节由需求方兜底）。
  const advance = (): void => {
    if (next && !next.assignee) {
      setPick({ kind: "advance", stageKey: next.key, stageName: next.name });
      return;
    }
    void run(() => flowTask(task.task_id, "advance"));
  };

  return (
    <div
      className="tool-block flow-bar"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        // .pane-tools.floating 悬浮在右上角，给按钮/状态行留出空间。
        paddingRight: 92,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span title={task.title} style={{ fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          🧭 {task.title}
        </span>
        <StageChain task={task} />
        {task.description && (
          <button
            className="del"
            style={{ fontSize: 11 }}
            onClick={() => setDescOpen((v) => !v)}
          >
            {descOpen ? "▲" : "▼"} {t("task.descToggle")}
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <RoleLine task={task} />
        <span style={{ flex: 1 }} />
        {/* 按角色/环节的流转按钮（与服务端矩阵一致；执法在服务端）。 */}
        {canAdvance && (
          <button className="primary" disabled={busy} onClick={advance}>
            {next
              ? t("task.advanceNext", { stage: next.name })
              : `✓ ${t("task.advanceFinish")}`}
          </button>
        )}
        {canSendBack && (
          <button disabled={busy} onClick={() => setBackOpen((v) => !v)}>
            {t("task.sendBack")}
          </button>
        )}
        {canAssign && (
          <button disabled={busy} onClick={() => setAssignOpen((v) => !v)}>
            {t("task.assign")}
          </button>
        )}
        {/* 需求方放弃任务：任意在途状态可取消（与删除任务线程同款守卫）。 */}
        {active && isRequester && (
          <button
            disabled={busy}
            onClick={() => void run(() => flowTask(task.task_id, "cancel"))}
          >
            {t("task.cancel")}
          </button>
        )}
      </div>

      {/* 打回：行内展开此前环节（可附备注；Electron 无 window.prompt）。 */}
      {backOpen && canSendBack && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("task.sendBackTitle")}：</span>
          {task.stages.slice(0, curIdx).map((s) => (
            <button
              key={s.key}
              disabled={busy}
              onClick={() => {
                const n = backNote.trim();
                setBackOpen(false);
                setBackNote("");
                void run(() =>
                  flowTask(task.task_id, "send_back", {
                    stageKey: s.key,
                    ...(n ? { note: n } : {}),
                  }),
                );
              }}
            >
              {t("task.backToStage", { stage: s.name })}
            </button>
          ))}
          <input
            value={backNote}
            placeholder="💬 …"
            style={{ flex: 1, minWidth: 120, fontSize: 12 }}
            onChange={(e) => setBackNote(e.target.value)}
          />
        </div>
      )}

      {/* 指派/换人：行内展开环节列表（显示现有负责人），点环节再选人。 */}
      {assignOpen && canAssign && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("task.assignStageTitle")}：</span>
          {task.stages.map((s) => (
            <button
              key={s.key}
              disabled={busy}
              onClick={() =>
                setPick({ kind: "assign", stageKey: s.key, stageName: s.name })
              }
            >
              {s.name}
              <span style={{ color: "var(--muted)", marginLeft: 4 }}>
                {s.assignee ?? t("task.stageUnassigned")}
              </span>
            </button>
          ))}
        </div>
      )}

      {descOpen && task.description && (
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "var(--muted)" }}>
          {task.description}
        </div>
      )}

      {/* 当前负责人离线：执行面（本机执行/审批/发言推进）跟随负责人，
          他离线时线程无法推进——需求方本人仍可旁观与发言。 */}
      {!executorOnline && active && (
        <div style={{ fontSize: 11, color: "#e5a83a" }}>
          ⚠ {t("task.executorOffline")}
        </div>
      )}

      {pick && (
        <UserPickerDialog
          title={t("task.assignStagePick", { stage: pick.stageName })}
          optionalSkip={pick.kind === "advance" ? t("task.pickExecutorSkip") : undefined}
          includeSelf
          onPick={(user) => {
            if (pick.kind === "advance") {
              // 两次 REST：先推进再给下一环节补指派（失败可见，可重试指派）。
              void run(async () => {
                const ok = await flowTask(task.task_id, "advance");
                if (ok && user) {
                  await flowTask(task.task_id, "assign", {
                    stageKey: pick.stageKey,
                    target: user,
                  });
                }
                return ok;
              });
            } else if (user) {
              void run(() =>
                flowTask(task.task_id, "assign", {
                  stageKey: pick.stageKey,
                  target: user,
                }),
              );
            }
          }}
          onClose={() => setPick(null)}
        />
      )}
    </div>
  );
}
