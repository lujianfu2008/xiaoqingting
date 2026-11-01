import { useState } from "react";
import type { TaskView } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";
import { executorOfTask } from "../../store/types";
import { FLOW_STATUS_LABEL } from "./MessageBlock";
import { UserPickerDialog } from "../UserPickerDialog";

// 协作流流程条（需求 → 研发 → 测试）：挂在会话顶部，仅当当前会话绑定了
// 任务线程时渲染，普通会话零改动。按钮显隐按服务端同一矩阵（执法在服务端）。

type PickMode = "dev" | "tester" | "reassign";

// 状态胶囊链：analyzing → developing → testing(修复中⇄) → done。
function StatusChain({ task }: { task: TaskView }): React.JSX.Element {
  const pill = (label: string, active: boolean, dim: boolean): React.JSX.Element => (
    <span
      style={{
        fontSize: 11,
        padding: "1px 8px",
        borderRadius: 999,
        border: `1px solid ${active ? "#4aa3ff" : "var(--border, #444)"}`,
        background: active ? "rgba(74,163,255,.15)" : "transparent",
        color: dim ? "var(--muted)" : active ? "#4aa3ff" : "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
  const cur = task.status;
  const testingActive = cur === "testing" || cur === "fixing";
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {pill(FLOW_STATUS_LABEL.analyzing, cur === "analyzing", cur === "done")}
      <span style={{ color: "var(--muted)", fontSize: 10 }}>→</span>
      {pill(FLOW_STATUS_LABEL.developing, cur === "developing", cur === "done")}
      <span style={{ color: "var(--muted)", fontSize: 10 }}>→</span>
      {pill(
        cur === "fixing" ? FLOW_STATUS_LABEL.fixing : FLOW_STATUS_LABEL.testing,
        testingActive,
        cur === "done",
      )}
      <span style={{ color: "var(--muted)", fontSize: 10 }}>→</span>
      {pill(FLOW_STATUS_LABEL.done, cur === "done", false)}
    </span>
  );
}

function RoleLine({ task }: { task: TaskView }): React.JSX.Element {
  const t = useT();
  const presence = useStore((s) => s.presence);
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
      {role(t("task.roleDev"), task.dev)}
      {role(t("task.roleTester"), task.tester)}
    </span>
  );
}

export function FlowBar({ task }: { task: TaskView }): React.JSX.Element {
  const t = useT();
  const me = useStore((s) => s.username);
  const flowTask = useStore((s) => s.flowTask);
  const executor = executorOfTask(task);
  const executorOnline = useStore((s) => s.presence[executor] ?? false);
  const [pickMode, setPickMode] = useState<PickMode | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueNote, setIssueNote] = useState("");
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
  const isDev = me != null && task.dev === me;
  const isTester = me != null && task.tester === me;
  const s = task.status;

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
        <StatusChain task={task} />
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
        {/* 按角色的流转按钮（与服务端矩阵一致；执法在服务端）。 */}
        {isRequester && s === "analyzing" && (
          <button className="primary" disabled={busy} onClick={() => setPickMode("dev")}>
            {t("task.assignDev")}
          </button>
        )}
        {isDev && s === "developing" && (
          <button className="primary" disabled={busy} onClick={() => setPickMode("tester")}>
            {t("task.submitTest")}
          </button>
        )}
        {s === "testing" && (isDev || isRequester) && (
          <button disabled={busy} onClick={() => setPickMode("reassign")}>
            {t("task.assignTester")}
          </button>
        )}
        {isTester && s === "testing" && (
          <>
            <button disabled={busy} onClick={() => setIssueOpen((v) => !v)}>
              {t("task.reportIssue")}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => flowTask(task.task_id, "pass"))}
            >
              ✓ {t("task.pass")}
            </button>
          </>
        )}
        {isDev && s === "fixing" && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run(() => flowTask(task.task_id, "resubmit"))}
          >
            {t("task.resubmit")}
          </button>
        )}
      </div>

      {/* 反馈问题：行内输入（Electron 无 window.prompt）。 */}
      {issueOpen && isTester && s === "testing" && (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <textarea
            autoFocus
            value={issueNote}
            placeholder={t("task.issuePh")}
            style={{ flex: 1, minHeight: 52, fontSize: 12 }}
            onChange={(e) => setIssueNote(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !issueNote.trim()}
            onClick={() => {
              const note = issueNote.trim();
              if (!note) return;
              void run(() => flowTask(task.task_id, "report_issue", undefined, note)).then(
                (ok) => {
                  if (ok) {
                    setIssueNote("");
                    setIssueOpen(false);
                  }
                },
              );
            }}
          >
            {t("task.issueSubmit")}
          </button>
        </div>
      )}

      {descOpen && task.description && (
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "var(--muted)" }}>
          {task.description}
        </div>
      )}

      {/* 当前负责人离线：执行面（本机执行/审批/发言推进）跟随负责人，
          他离线时线程无法推进——需求方本人仍可旁观与发言。 */}
      {!executorOnline && s !== "done" && (
        <div style={{ fontSize: 11, color: "#e5a83a" }}>
          ⚠ {t("task.executorOffline")}
        </div>
      )}

      {pickMode && (
        <UserPickerDialog
          title={pickMode === "dev" ? t("task.pickDev") : t("task.pickTester")}
          optionalSkip={pickMode === "tester" ? t("task.skipNoTester") : undefined}
          exclude={[
            ...(task.dev ? [task.dev] : []),
            ...(pickMode !== "reassign" && task.tester ? [task.tester] : []),
          ]}
          onPick={(user) => {
            if (pickMode === "dev" && user) {
              void run(() => flowTask(task.task_id, "assign_dev", user));
            } else if (pickMode === "tester") {
              void run(() => flowTask(task.task_id, "submit_test", user ?? undefined));
            } else if (pickMode === "reassign" && user) {
              void run(() => flowTask(task.task_id, "assign_tester", user));
            }
          }}
          onClose={() => setPickMode(null)}
        />
      )}
    </div>
  );
}
