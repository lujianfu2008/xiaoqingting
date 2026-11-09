import fs from "node:fs";
import path from "node:path";
import { ScheduleView } from "@blm/protocol";
import { config } from "./config.js";

// 定时任务存储：单文件 data/scheduled-tasks.json（任务量小、无敏感字段，照
// workflowConfig.ts 模式：readJson catch→默认、逐条 safeParse 静默丢弃非法条目、
// writeFileSync 落盘）。ScheduleView 即落盘形状（无敏感字段，同 TaskRecord 先例，
// 不另立 Record 类型）。next_run_at 持久化：服务器重启后调度自然恢复。

export type ScheduleRecord = ScheduleView;

function file(): string {
  return path.join(config.dataDir, "scheduled-tasks.json");
}

function readJson(f: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function loadAll(): Record<string, ScheduleRecord> {
  const parsed = readJson(file()) as { tasks?: unknown } | null;
  const raw = parsed && typeof parsed === "object" ? parsed.tasks : null;
  const out: Record<string, ScheduleRecord> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
    const ok = ScheduleView.safeParse(rec);
    if (ok.success) out[id] = ok.data;
  }
  return out;
}

export function saveAll(map: Record<string, ScheduleRecord>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ tasks: map }, null, 2));
}

/** 某用户的任务列表：next_run_at 升序（null = 已停用排最后），再 created_at 倒序。 */
export function listSchedules(owner: string): ScheduleRecord[] {
  return Object.values(loadAll())
    .filter((r) => r.owner === owner)
    .sort((a, b) => {
      const an = a.next_run_at ? Date.parse(a.next_run_at) : Number.POSITIVE_INFINITY;
      const bn = b.next_run_at ? Date.parse(b.next_run_at) : Number.POSITIVE_INFINITY;
      if (an !== bn) return an - bn;
      return b.created_at.localeCompare(a.created_at);
    });
}

/** 单条读取，含所有权比较（owner 不符与不存在同样返回 null）。 */
export function getSchedule(owner: string, id: string): ScheduleRecord | null {
  const rec = loadAll()[id];
  return rec && rec.owner === owner ? rec : null;
}

export function saveSchedule(rec: ScheduleRecord): void {
  const all = loadAll();
  all[rec.schedule_id] = rec;
  saveAll(all);
}

export function deleteSchedule(owner: string, id: string): boolean {
  const all = loadAll();
  const rec = all[id];
  if (!rec || rec.owner !== owner) return false;
  delete all[id];
  saveAll(all);
  return true;
}

/** 同 owner 内名称唯一（编辑时排除自身 id）。 */
export function scheduleNameTaken(owner: string, name: string, excludeId?: string): boolean {
  return Object.values(loadAll()).some(
    (r) => r.owner === owner && r.name === name && r.schedule_id !== excludeId,
  );
}
