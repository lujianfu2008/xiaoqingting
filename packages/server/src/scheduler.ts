import type { ScheduleTime, ScheduleView, SessionMeta } from "@blm/protocol";
import type { AgentManager } from "./agent/AgentManager.js";
import type { Store, SessionRecord } from "./store.js";
import { getUserRecord } from "./users.js";
import {
  loadAll,
  getSchedule,
  saveSchedule,
  saveAll,
  type ScheduleRecord,
} from "./scheduleStore.js";

// 定时任务调度器：20s tick 比对 next_run_at，到点在主人在线的前提下以主人身份
// 调 manager.handleUserMessage 驱动一轮（owner 身份使 messageRouter 的
// executor_offline 守卫短路放行，本机执行也正确落在主人机器）。主人不在线或
// 引擎忙则跳过记错过——本机工具与 LLM 借网都依赖桌面在线，硬跑只会产出残缺
// 回答。next_run_at 全程持久化，重启后首 tick 自然命中过期任务走同一状态机。

const TICK_MS = 20_000;

/** 目标用户必须存在、已过审且未禁用（照 taskManager.userUsable）。 */
function userUsable(t: string): boolean {
  const u = getUserRecord(t);
  return !!u && u.status === "approved" && !u.disabled;
}

type SkipReason = NonNullable<ScheduleView["last_skip_reason"]>;

// 与 messageRouter 首条消息广播同构的 SessionMeta 视图。
function toMeta(rec: SessionRecord): SessionMeta {
  return {
    session_id: rec.session_id,
    title: rec.title,
    agent_id: rec.agent_id,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    project_id: rec.project_id ?? null,
    shared: rec.shared ?? false,
    shared_with: rec.shared_with ?? [],
    ...(rec.approvers?.length ? { approvers: rec.approvers } : {}),
    owner: rec.user_id,
  };
}

/** DST 无关的简单日推算（产品部署在中国时区，无夏令时）。 */
function atHhMm(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * 下一次触发时间（服务器本地时区）。
 * - once 恒 null：一次性只有 fire/skip 两条出路（创建时 next_run_at=at）。
 * - interval 以 created_at 为锚点做网格对齐，严格 > from（迟到 tick 不重跑），
 *   重启/宕机/编辑 minutes 都不漂移。
 */
export function computeNextRunAt(time: ScheduleTime, from: Date, anchorIso: string): string | null {
  switch (time.kind) {
    case "once":
      return null;
    case "daily": {
      const today = atHhMm(from, time.time);
      if (today.getTime() > from.getTime()) return today.toISOString();
      return atHhMm(new Date(from.getTime() + 86_400_000), time.time).toISOString();
    }
    case "weekly": {
      for (let off = 0; off < 8; off++) {
        const day = new Date(from.getTime() + off * 86_400_000);
        if (!time.weekdays.includes(day.getDay())) continue;
        const cand = atHhMm(day, time.time);
        if (cand.getTime() > from.getTime()) return cand.toISOString();
      }
      // weekdays 非空时上面必然命中；纯兜底。
      return atHhMm(new Date(from.getTime() + 7 * 86_400_000), time.time).toISOString();
    }
    case "interval": {
      const step = time.minutes * 60_000;
      const anchor = Date.parse(anchorIso);
      if (!Number.isFinite(anchor)) return new Date(from.getTime() + step).toISOString();
      // 网格点 = anchor + k*step，取严格 > from 的第一个：floor(elapsed/step)+1
      // （elapsed 恰为整格时也 +1，迟到 tick 不重跑）。
      const k = Math.floor((from.getTime() - anchor) / step) + 1;
      const next = anchor + k * step;
      // 时钟回拨等异常导致未越过 from 时回退线性推进。
      if (next <= from.getTime()) return new Date(from.getTime() + step).toISOString();
      return new Date(next).toISOString();
    }
  }
}

export class ScheduleScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private manager: AgentManager,
    private store: Store,
  ) {}

  start(): void {
    if (this.timer) return;
    // 防御：enabled 但缺 next_run_at 的记录补算一次（正常不会出现；once 的
    // 计划就是 time.at 本身）。
    const all = loadAll();
    const now = new Date();
    let dirty = false;
    for (const rec of Object.values(all)) {
      if (!rec.enabled || rec.next_run_at) continue;
      rec.next_run_at =
        rec.time.kind === "once" ? rec.time.at : computeNextRunAt(rec.time, now, rec.created_at);
      dirty = true;
    }
    if (dirty) saveAll(all);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 手动「立即执行」：忽略 next_run_at 进同一状态机；被跳过也返回记录供 UI 提示。 */
  triggerNow(
    owner: string,
    id: string,
  ): { ok: true; rec: ScheduleRecord } | { ok: false; code: "not_found" | "forbidden" } {
    const rec = getSchedule(owner, id);
    if (!rec) return { ok: false, code: "not_found" };
    if (rec.owner !== owner) return { ok: false, code: "forbidden" };
    this.fire(rec, true);
    return { ok: true, rec: getSchedule(owner, id) ?? rec };
  }

  /** 变更推送（创建/更新/启停/触发/跳过）只发任务主人；离线为 no-op，靠 REST 播种收敛。 */
  notify(rec: ScheduleRecord, session?: SessionMeta): void {
    this.manager.sendToUser(rec.owner, {
      type: "schedule_update",
      schedule: rec,
      ...(session ? { session } : {}),
    });
  }

  private tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      // 每个 tick 重读文件拿最新状态（路由/其他进程可能刚改过）。
      for (const rec of Object.values(loadAll())) {
        if (!rec.enabled || !rec.next_run_at) continue;
        if (Date.parse(rec.next_run_at) > now) continue;
        this.fire(rec, false);
      }
    } finally {
      this.ticking = false;
    }
  }

  private fire(rec0: ScheduleRecord, manual: boolean): void {
    if (!manual && !rec0.enabled) return;
    if (!userUsable(rec0.owner)) {
      this.skip(rec0, "user_disabled", manual);
      return;
    }
    if (!this.manager.isOnline(rec0.owner)) {
      this.skip(rec0, "owner_offline", manual);
      return;
    }
    // 引擎上一轮还在跑：跳过不排队（排队会把定时指示词并进进行中回合，语义
    // 混乱）。只查已有绑定会话；未建会话时必然空闲，也避免 skip 路径白建空会话。
    if (rec0.session_id && this.manager.isSessionBusy(rec0.session_id)) {
      this.skip(rec0, "session_busy", manual);
      return;
    }
    const ensured = this.ensureSession(rec0);
    if (!ensured) {
      console.error(`[scheduler] 专属会话创建失败，本轮放弃: ${rec0.schedule_id}`);
      return;
    }
    const rec: ScheduleRecord = { ...rec0, session_id: ensured.session_id };

    // 提交点先落盘再驱动：崩溃时宁可丢一轮也不重复 fire once。
    const now = new Date();
    const next: ScheduleRecord = {
      ...rec,
      last_run_at: now.toISOString(),
      run_count: rec.run_count + 1,
      last_result: "fired",
      last_skip_reason: null,
    };
    if (rec.time.kind === "once") {
      next.enabled = false;
      next.next_run_at = null;
    } else if (!manual) {
      // 手动触发是额外一轮，不改计划节奏。
      next.next_run_at = computeNextRunAt(rec.time, now, rec.created_at);
    }
    saveSchedule(next);
    this.notify(next, ensured.recreated ? ensured.meta : undefined);
    this.manager.handleUserMessage(rec.owner, ensured.session_id, rec.prompt);
  }

  private skip(rec: ScheduleRecord, reason: SkipReason, manual: boolean): void {
    const now = new Date();
    const next: ScheduleRecord = {
      ...rec,
      missed_count: manual ? rec.missed_count : rec.missed_count + 1,
      last_result: "skipped",
      last_skip_reason: reason,
    };
    if (rec.time.kind === "once") {
      // 一次性错过即停用（提醒类任务过期无意义）。
      next.enabled = false;
      next.next_run_at = null;
    } else if (!manual) {
      // 错过就错过，从当前时刻向后重算，不补跑。
      next.next_run_at = computeNextRunAt(rec.time, now, rec.created_at);
    }
    saveSchedule(next);
    this.notify(next);
  }

  /** 专属会话：首触自动创建；绑定会话被用户删除后重建（title=任务名，天然不触发改题）。 */
  private ensureSession(
    rec: ScheduleRecord,
  ): { session_id: string; meta: SessionMeta; recreated: boolean } | null {
    const existing = rec.session_id ? this.store.getSession(rec.session_id) : null;
    if (existing) return { session_id: existing.session_id, recreated: false, meta: toMeta(existing) };
    const created = this.manager.createSession(rec.owner, rec.agent_id, rec.name, null);
    if (!created) return null;
    return { session_id: created.session_id, recreated: true, meta: toMeta(created) };
  }
}
