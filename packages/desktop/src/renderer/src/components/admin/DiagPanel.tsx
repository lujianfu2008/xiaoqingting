import { useEffect, useState } from "react";
import type { DiagEntryMeta } from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 管理页「显示诊断」tab（仅管理员）：对在线用户发起采集
// （布局摘要 / 布局+整窗截图），查看回传结果。摘要是一份
// 纯几何数字（窗口/pane 宽度、原生页面 view 摆位），排显
// 示脱节问题用；截图含聊天内容，发起处明示。

/** 一行摘要的键值展示（数字四舍五入去掉尾零）。 */
function fmt(n: number | null): string {
  return n == null ? "—" : String(Math.round(n));
}

function LayoutBlock(): React.JSX.Element | null {
  const [layout, setLayout] = useState<Awaited<
    ReturnType<ReturnType<typeof useStore.getState>["loadDiagDetail"]>
  > | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const diagList = useStore((s) => s.diagList);
  const loadDiagList = useStore((s) => s.loadDiagList);
  const loadDiagDetail = useStore((s) => s.loadDiagDetail);
  const deleteDiagEntry = useStore((s) => s.deleteDiagEntry);
  const t = useT();

  useEffect(() => {
    void loadDiagList();
  }, [loadDiagList]);

  const open = async (id: string): Promise<void> => {
    setSel(id);
    setLayout(null);
    const d = await loadDiagDetail(id);
    setLayout(d);
  };

  const del = async (id: string): Promise<void> => {
    if (!window.confirm(t("dg.deleteConfirm"))) return;
    const ok = await deleteDiagEntry(id);
    if (ok && sel === id) {
      setSel(null);
      setLayout(null);
    }
    void loadDiagList();
  };

  const l = layout?.layout ?? null;
  const shot = layout?.screenshot ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {diagList.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>
          {t("dg.empty")}
        </div>
      )}
      {diagList.map((e: DiagEntryMeta) => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            style={{
              flex: 1,
              textAlign: "left",
              fontSize: 12,
              border: sel === e.id ? "1px solid var(--primary)" : "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 8px",
              background: "transparent",
              color: "var(--text)",
            }}
            onClick={() => void open(e.id)}
          >
            <span style={{ fontWeight: 600 }}>{e.username}</span>
            <span style={{ color: "var(--muted)", marginLeft: 8 }}>
              {e.scope === "screenshot" ? t("dg.scopeShot") : t("dg.scopeLayout")}
            </span>
            <span style={{ color: "var(--muted)", float: "right" }}>
              {new Date(e.at).toLocaleString()}
            </span>
          </button>
          <button
            title={t("dg.delete")}
            style={{
              fontSize: 11,
              padding: "2px 6px",
              color: "var(--danger, #e5534b)",
              flexShrink: 0,
            }}
            onClick={() => void del(e.id)}
          >
            ✕
          </button>
        </div>
      ))}
      {l && (
        <div
          style={{
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontFamily: "monospace",
          }}
        >
          <div>
            v{l.app_version} · {l.viewport.w}×{l.viewport.h} @
            {l.viewport.dpr}x
          </div>
          <div>
            panes: sidebar={fmt(l.panes.sidebar)} chat={fmt(l.panes.chat)}{" "}
            viewer={fmt(l.panes.viewer)} browser={fmt(l.panes.browser)}
          </div>
          <div>
            view: {l.browser_view.open ? "open" : "closed"}{" "}
            {l.browser_view.bounds
              ? `(${l.browser_view.bounds.x},${l.browser_view.bounds.y} ${l.browser_view.bounds.w}×${l.browser_view.bounds.h})`
              : "—"}
            {/* view 当时是否真按账面摆着（遮罩开着=被藏，
                截图只见 stage 白底——几何账面仍可信）。 */}
            {l.browser_view.view_posed === false && (
              <span style={{ color: "var(--muted)" }}>（遮罩藏起）</span>
            )}
          </div>
          <div>
            pane rect:{" "}
            {l.browser_pane_rect
              ? `(${l.browser_pane_rect.x},${l.browser_pane_rect.y} ${l.browser_pane_rect.w}×${l.browser_pane_rect.h})`
              : "—"}
          </div>
          {/* 脱节检查：view 与 pane rect 不重合即「页面挤错位」。 */}
          {l.browser_view.bounds && l.browser_pane_rect && (l.browser_view.open ?? false) && (
            (() => {
              const b = l.browser_view.bounds!;
              const p = l.browser_pane_rect!;
              const dx = b.x - p.x;
              const dw = b.w - p.w;
              const off = Math.abs(dx) > 2 || Math.abs(dw) > 2;
              return (
                <div style={{ color: off ? "var(--danger)" : "var(--ok, green)" }}>
                  {off
                    ? t("dg.mismatch", { dx: String(Math.round(dx)), dw: String(Math.round(dw)) })
                    : t("dg.aligned")}
                </div>
              );
            })()
          )}
        </div>
      )}
      {shot && (
        <img
          alt="screenshot"
          src={`data:${shot.media_type};base64,${shot.data}`}
          style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8 }}
        />
      )}
    </div>
  );
}

export function AdminDiagPanel(): React.JSX.Element {
  const users = useStore((s) => s.listAdminUsers);
  const collectDiagFrom = useStore((s) => s.collectDiagFrom);
  const loadDiagList = useStore((s) => s.loadDiagList);
  const [list, setList] = useState<Awaited<ReturnType<typeof users>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void users().then(setList);
  }, [users]);

  const collect = async (username: string, scope: "layout" | "screenshot"): Promise<void> => {
    setBusy(username + scope);
    setMsg(null);
    const err = await collectDiagFrom(username, scope);
    setBusy(null);
    if (err) {
      setMsg(err === "user_offline" ? t("dg.offline") : t("dg.fail"));
      return;
    }
    setMsg(t("dg.sent"));
    // 结果是异步回传的：稍后自动刷新一次列表。
    setTimeout(() => void loadDiagList(), 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("dg.hint")}</div>
      {(list ?? []).map((u) => (
        <div
          key={u.username}
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
        >
          <span style={{ flex: 1 }}>
            {u.username}
            <span style={{ color: "var(--muted)", marginLeft: 6 }}>
              {u.online ? t("dg.online") : t("dg.off")}
            </span>
          </span>
          <button
            disabled={!u.online || busy != null}
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => void collect(u.username, "layout")}
          >
            {busy === u.username + "layout" ? "…" : t("dg.collectLayout")}
          </button>
          <button
            disabled={!u.online || busy != null}
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => void collect(u.username, "screenshot")}
          >
            {busy === u.username + "screenshot" ? "…" : t("dg.collectShot")}
          </button>
        </div>
      ))}
      {msg && <div style={{ fontSize: 12, color: "var(--muted)" }}>{msg}</div>}
      <DiagTaskBlock list={list ?? []} />
      <LayoutBlock />
    </div>
  );
}

/** 远程诊断任务区块：借用在线客户端的智能体跑只读探查，
 *  报告落存档（结果在这里看）。 */
function DiagTaskBlock(props: {
  list: { username: string; online?: boolean }[];
}): React.JSX.Element {
  const diagTaskList = useStore((s) => s.diagTaskList);
  const startDiagTask = useStore((s) => s.startDiagTask);
  const loadDiagTaskList = useStore((s) => s.loadDiagTaskList);
  const loadDiagTaskDetail = useStore((s) => s.loadDiagTaskDetail);
  const deleteDiagTask = useStore((s) => s.deleteDiagTask);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<{ id: string; text: string | null; status: string; note?: string } | null>(null);
  const t = useT();

  useEffect(() => {
    void loadDiagTaskList();
  }, [loadDiagTaskList]);

  // running 的任务定时刷新（报告是异步落档的）。
  useEffect(() => {
    if (!diagTaskList.some((e) => e.status === "running")) return;
    const iv = setInterval(() => void loadDiagTaskList(), 10_000);
    return () => clearInterval(iv);
  }, [diagTaskList, loadDiagTaskList]);

  const start = async (username: string): Promise<void> => {
    setBusy(username);
    const err = await startDiagTask(username, "display_layout");
    setBusy(null);
    if (err) {
      setReport({ id: "", text: null, status: err === "user_offline" ? "offline" : "fail" });
      return;
    }
    await loadDiagTaskList();
    setReport({ id: "", text: null, status: "started" });
  };

  const open = async (id: string): Promise<void> => {
    setBusy(id);
    const d = await loadDiagTaskDetail(id);
    setBusy(null);
    if (!d) return;
    setReport({
      id,
      text: d.report ?? t("dg.taskPending"),
      status: d.entry.status,
      note: d.entry.note,
    });
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(id);
    await deleteDiagTask(id);
    setBusy(null);
    if (report?.id === id) setReport(null);
    await loadDiagTaskList();
  };

  const statusLabel = (s: string): string =>
    s === "running"
      ? t("dg.taskRunning")
      : s === "done"
        ? t("dg.taskDone")
        : s === "timeout"
          ? t("dg.taskTimeout")
          : s === "error"
            ? t("dg.taskError")
            : s;

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("dg.taskHint")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {props.list
          .filter((u) => u.online === true)
          .map((u) => (
            <button
              key={u.username}
              disabled={busy != null}
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => void start(u.username)}
            >
              {busy === u.username ? "…" : `${t("dg.taskStart")} · ${u.username}`}
            </button>
          ))}
      </div>
      {report?.status === "started" && (
        <div style={{ fontSize: 12, color: "var(--ok, green)" }}>{t("dg.taskStarted")}</div>
      )}
      {report && ["offline", "fail"].includes(report.status) && (
        <div style={{ fontSize: 12, color: "var(--danger)" }}>{t("dg.fail")}</div>
      )}
      {diagTaskList.map((e) => (
        <div
          key={e.task_id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "4px 8px",
          }}
        >
          <span style={{ fontWeight: 600 }}>{e.username}</span>
          <span style={{ color: e.status === "done" ? "var(--ok, green)" : e.status === "running" ? "var(--warn)" : "var(--muted)" }}>
            {statusLabel(e.status)}
          </span>
          <span style={{ color: "var(--muted)", flex: 1 }}>{new Date(e.at).toLocaleString()}</span>
          <button
            disabled={busy === e.task_id || e.status === "running"}
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => void open(e.task_id)}
          >
            {t("dg.taskReport")}
          </button>
          <button
            disabled={busy === e.task_id}
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => void remove(e.task_id)}
          >
            ✕
          </button>
        </div>
      ))}
      {report?.text != null && (
        <div
          style={{
            fontSize: 12,
            whiteSpace: "pre-wrap",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 10px",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {report.note ? `${report.note}\n\n` : ""}
          {report.text}
        </div>
      )}
    </div>
  );
}
