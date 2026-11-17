import { useState } from "react";
import type {
  CreateScheduleRequest,
  ScheduleTime,
  ScheduleView,
  UpdateScheduleRequest,
} from "@blm/protocol";
import { useStore } from "../../store";
import { useT } from "../../i18n";

// 定时任务表单（新建或编辑，内联使用）：四种触发计划选择器。
// 从设置面板抽出的共享组件；projectPreset = 定时任务项目内创建时预设
// 归属项目与 agent（创建请求带 project_id）。

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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// 星期几 → i18n key（字面量联合）。
const WEEKDAY_KEYS = [
  "sc.weekday0",
  "sc.weekday1",
  "sc.weekday2",
  "sc.weekday3",
  "sc.weekday4",
  "sc.weekday5",
  "sc.weekday6",
] as const;

function weekdayKey(w: number): (typeof WEEKDAY_KEYS)[number] {
  return WEEKDAY_KEYS[w];
}

/** 计划时间的人类可读描述（列表行用）。 */
export function timeToText(time: ScheduleTime, tf: ReturnType<typeof useT>): string {
  switch (time.kind) {
    case "once":
      return new Date(time.at).toLocaleString();
    case "daily":
      return `${tf(KIND_KEYS.daily)} ${time.time}`;
    case "weekly":
      return `${tf(KIND_KEYS.weekly)}（${time.weekdays.map((w) => tf(weekdayKey(w))).join("/")}） ${time.time}`;
    case "interval":
      return `${tf(KIND_KEYS.interval)} ${time.minutes} ${tf("sc.intervalUnit")}`;
  }
}

// ---------- 表单（新建或编辑，内联使用） ----------

export function ScheduleForm({
  initial,
  projectPreset,
  onDone,
}: {
  initial: ScheduleView | null;
  projectPreset?: { project_id: string; agentId?: string };
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const create = useStore((s) => s.createSchedule);
  const update = useStore((s) => s.updateSchedule);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentId, setAgentId] = useState(
    initial?.agent_id ?? projectPreset?.agentId ?? agents[0]?.agent_id ?? "assistant",
  );
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
          ...(projectPreset ? { project_id: projectPreset.project_id } : {}),
        };
        await update(initial.schedule_id, body);
      } else {
        const body: CreateScheduleRequest = {
          name: trimmedName,
          prompt: trimmedPrompt,
          agent_id: agentId,
          time,
          enabled,
          ...(projectPreset ? { project_id: projectPreset.project_id } : {}),
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
                    {t(weekdayKey(w))}
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

