import { useEffect, useState } from "react";
import type {
  CreateScheduleRequest,
  ScheduleTime,
  ScheduleView,
  UpdateScheduleRequest,
} from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 定时任务设置面板：列表（下次运行/上次结果/错过徽标）+ 内联表单（四种触发
// 计划选择器）。到点执行由服务端完成（主人的专属会话里自动跑一轮），这里只做
// 配置管理；结构照 WorkflowsPanel（常驻挂载 + 内联编辑 + busy/err）。

// ISO → datetime-local 输入值（本地时区）。
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// i18n 的 key 是严格字面量联合，动态拼 key 过不了 typecheck——用映射表。
const KIND_KEYS = {
  once: "sc.kindOnce",
  daily: "sc.kindDaily",
  weekly: "sc.kindWeekly",
  interval: "sc.kindInterval",
} as const;

const WEEKDAY_KEYS = [
  "sc.weekday0",
  "sc.weekday1",
  "sc.weekday2",
  "sc.weekday3",
  "sc.weekday4",
  "sc.weekday5",
  "sc.weekday6",
] as const;

function timeToText(time: ScheduleTime, tf: ReturnType<typeof useT>): string {
  switch (time.kind) {
    case "once":
      return new Date(time.at).toLocaleString();
    case "daily":
      return `${tf(KIND_KEYS.daily)} ${time.time}`;
    case "weekly":
      return `${tf(KIND_KEYS.weekly)}（${time.weekdays.map((w) => tf(WEEKDAY_KEYS[w])).join("/")}） ${time.time}`;
    case "interval":
      return `${tf(KIND_KEYS.interval)} ${time.minutes} ${tf("sc.intervalUnit")}`;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- 表单（新建或编辑） ----------

function ScheduleForm({
  initial,
  onDone,
}: {
  initial: ScheduleView | null;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const create = useStore((s) => s.createSchedule);
  const update = useStore((s) => s.updateSchedule);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentId, setAgentId] = useState(initial?.agent_id ?? agents[0]?.agent_id ?? "assistant");
  const [kind, setKind] = useState<ScheduleTime["kind"]>(initial?.time.kind ?? "daily");
  const [at, setAt] = useState(initial?.time.kind === "once" ? toLocalInput(initial.time.at) : "");
  const [dailyTime, setDailyTime] = useState(initial?.time.kind === "daily" ? initial.time.time : "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(
    initial?.time.kind === "weekly" ? [...initial.time.weekdays] : [1, 2, 3, 4, 5],
  );
  const [weeklyTime, setWeeklyTime] = useState(initial?.time.kind === "weekly" ? initial.time.time : "09:00");
  const [minutes, setMinutes] = useState(
    initial?.time.kind === "interval" ? String(initial.time.minutes) : "30",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleWeekday = (w: number): void => {
    setWeekdays((ws) => (ws.includes(w) ? ws.filter((x) => x !== w) : [...ws, w]));
  };

  const buildTime = (): ScheduleTime | null => {
    switch (kind) {
      case "once": {
        const ms = at ? Date.parse(at) : Number.NaN;
        return Number.isNaN(ms) ? null : { kind: "once", at: new Date(ms).toISOString() };
      }
      case "daily":
        return HHMM.test(dailyTime) ? { kind: "daily", time: dailyTime } : null;
      case "weekly":
        return weekdays.length > 0 && HHMM.test(weeklyTime)
          ? { kind: "weekly", weekdays: [...weekdays].sort(), time: weeklyTime }
          : null;
      case "interval": {
        const n = Number(minutes);
        return Number.isInteger(n) && n >= 5 && n <= 43200
          ? { kind: "interval", minutes: n }
          : null;
      }
    }
  };

  const submit = async (): Promise<void> => {
    setErr(null);
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    const time = buildTime();
    if (!trimmedName || !trimmedPrompt || !time) {
      setErr(t("sc.errForm"));
      return;
    }
    setBusy(true);
    try {
      if (initial) {
        const body: UpdateScheduleRequest = {
          name: trimmedName,
          prompt: trimmedPrompt,
          agent_id: agentId,
          time,
          enabled,
        };
        await update(initial.schedule_id, body);
      } else {
        const body: CreateScheduleRequest = {
          name: trimmedName,
          prompt: trimmedPrompt,
          agent_id: agentId,
          time,
          enabled,
        };
        await create(body);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("sc.saveFail"));
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
        <label>{t("sc.name")}</label>
        <input
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sc.namePh")}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("sc.agent")}</label>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("sc.prompt")}</label>
        <textarea
          value={prompt}
          maxLength={8000}
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("sc.promptPh")}
        />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{t("sc.time")}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {(["once", "daily", "weekly", "interval"] as const).map((k) => (
              <button
                key={k}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  fontWeight: kind === k ? 700 : 400,
                  borderColor: kind === k ? "var(--accent)" : undefined,
                }}
                onClick={() => setKind(k)}
              >
                {t(KIND_KEYS[k])}
              </button>
            ))}
          </div>
          {kind === "once" && (
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          )}
          {kind === "daily" && (
            <input type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} />
          )}
          {kind === "weekly" && (
            <>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[1, 2, 3, 4, 5, 6, 0].map((w) => (
                  <button
                    key={w}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      fontWeight: weekdays.includes(w) ? 700 : 400,
                      borderColor: weekdays.includes(w) ? "var(--accent)" : undefined,
                    }}
                    onClick={() => toggleWeekday(w)}
                  >
                    {t(WEEKDAY_KEYS[w])}
                  </button>
                ))}
              </div>
              <input type="time" value={weeklyTime} onChange={(e) => setWeeklyTime(e.target.value)} />
            </>
          )}
          {kind === "interval" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12 }}>{t("sc.kindInterval")}</span>
              <input
                type="number"
                min={5}
                max={43200}
                value={minutes}
                style={{ width: 90 }}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <span style={{ fontSize: 12 }}>{t("sc.intervalUnit")}</span>
            </div>
          )}
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("sc.enabled")}
      </label>
      {err && <div className="error-text">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => void submit()}>
          {t("sc.save")}
        </button>
        <button style={{ fontSize: 12 }} disabled={busy} onClick={onDone}>
          {t("sc.cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------- 列表 ----------

function reasonKey(reason: NonNullable<ScheduleView["last_skip_reason"]>): "sc.reasonOwnerOffline" | "sc.reasonSessionBusy" | "sc.reasonUserDisabled" {
  return reason === "owner_offline"
    ? "sc.reasonOwnerOffline"
    : reason === "session_busy"
      ? "sc.reasonSessionBusy"
      : "sc.reasonUserDisabled";
}

export function SchedulesPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT();
  const loadSchedules = useStore((s) => s.loadSchedules);
  const schedules = useStore((s) => s.schedules);
  const trigger = useStore((s) => s.triggerSchedule);
  const toggle = useStore((s) => s.setScheduleEnabled);
  const remove = useStore((s) => s.deleteSchedule);
  const selectSession = useStore((s) => s.selectSession);
  const [editing, setEditing] = useState<string | null>(null); // schedule_id；"" = 新建
  const [err, setErr] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  useEffect(() => {
    void loadSchedules();
    // 面板常驻挂载（settings 各 tab 均不卸载），进设置页拉取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doRun = async (rec: ScheduleView): Promise<void> => {
    setErr(null);
    setRunNote(null);
    try {
      const after = await trigger(rec.schedule_id);
      if (after.last_result === "skipped" && after.last_skip_reason) {
        setRunNote(t("sc.runSkipped", { reason: t(reasonKey(after.last_skip_reason)) }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("sc.saveFail"));
    }
  };

  const doToggle = async (rec: ScheduleView): Promise<void> => {
    setErr(null);
    try {
      await toggle(rec.schedule_id, !rec.enabled);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("sc.saveFail"));
    }
  };

  const doRemove = async (rec: ScheduleView): Promise<void> => {
    if (!window.confirm(t("sc.deleteConfirm", { name: rec.name }))) return;
    setErr(null);
    try {
      await remove(rec.schedule_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("sc.saveFail"));
    }
  };

  const editingRec = schedules.find((x) => x.schedule_id === editing) ?? null;
  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 560 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {t("sc.note")}
      </div>

      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t("set.tabSchedules")}</div>
        <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setEditing("")}>
          {t("sc.add")}
        </button>
      </div>

      {editing !== null && <ScheduleForm initial={editingRec} onDone={() => setEditing(null)} />}

      {runNote && <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>{runNote}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {schedules.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{t("sc.empty")}</div>
        )}
        {schedules.map((rec) => (
          <div
            key={rec.schedule_id}
            style={{
              border: "1px solid var(--border, #ccc)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              opacity: rec.enabled ? 1 : 0.7,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{rec.name}</strong>
              <span
                style={{
                  fontSize: 10,
                  color: rec.enabled ? "var(--accent)" : "var(--muted)",
                }}
              >
                ● {rec.enabled ? t("sc.enabled") : t("sc.neverRun")}
              </span>
              {rec.missed_count > 0 && (
                <span style={{ fontSize: 10, color: "var(--muted)" }}>
                  {t("sc.missedBadge", { count: rec.missed_count })}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button
                style={{ fontSize: 11, padding: "1px 8px" }}
                disabled={!rec.enabled && rec.time.kind !== "once"}
                title={rec.enabled ? undefined : t("sc.enabled")}
                onClick={() => void doRun(rec)}
              >
                {t("sc.runNow")}
              </button>
              <button style={{ fontSize: 11, padding: "1px 8px" }} onClick={() => void doToggle(rec)}>
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
              <button style={{ fontSize: 11, padding: "1px 8px" }} onClick={() => setEditing(rec.schedule_id)}>
                {t("sc.edit")}
              </button>
              <button
                className="del"
                style={{ fontSize: 11, padding: "1px 8px" }}
                onClick={() => void doRemove(rec)}
              >
                {t("sc.delete")}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {timeToText(rec.time, t)} · {rec.agent_id}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {rec.next_run_at
                ? t("sc.nextRun", { time: new Date(rec.next_run_at).toLocaleString() })
                : t("sc.neverRun")}
              {rec.last_result === "fired" && rec.last_run_at
                ? ` · ${t("sc.lastFired", { time: new Date(rec.last_run_at).toLocaleString() })}`
                : rec.last_result === "skipped" && rec.last_skip_reason
                  ? ` · ${t("sc.lastSkipped", { reason: t(reasonKey(rec.last_skip_reason)) })}`
                  : ""}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, wordBreak: "break-all" }}>
              {rec.prompt}
            </div>
          </div>
        ))}
      </div>
      {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
