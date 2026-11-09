import { z } from "zod";
import { SessionMeta } from "./sessions.js";

// ---------- 定时任务（服务端按计划在用户专属会话里自动驱动 agent 回合） ----------

// HH:mm（24 小时制）。
export const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type HhMm = z.infer<typeof HhMm>;

// ISO 日期时间串（存储与传输统一 ISO，展示由客户端本地化）。
const IsoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)));

// 触发计划。服务器本地时区；interval 以任务创建时刻为锚点做网格对齐。
export const ScheduleTime = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: IsoDateTime }), // 单次绝对时间点
  z.object({ kind: z.literal("daily"), time: HhMm }), // 每天 HH:mm
  z.object({
    kind: z.literal("weekly"),
    weekdays: z.array(z.int().min(0).max(6)).min(1).max(7), // 0=周日（对齐 Date.getDay）
    time: HhMm,
  }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(43200) }), // 5 分钟 ~ 30 天
]);
export type ScheduleTime = z.infer<typeof ScheduleTime>;

// 名称/指示词/agent 角色（创建与更新共用）。
const ScheduleSpec = {
  name: z.string().trim().min(1).max(60),
  prompt: z.string().trim().min(1).max(8000),
  agent_id: z.string().trim().min(1).max(64),
};

// REST: 新建（next_run_at 服务端算）。
export const CreateScheduleRequest = z.object({
  ...ScheduleSpec,
  time: ScheduleTime,
  enabled: z.boolean().optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

// REST: 整体更新（PUT 语义，enabled 必填）。
export const UpdateScheduleRequest = z.object({
  ...ScheduleSpec,
  time: ScheduleTime,
  enabled: z.boolean(),
});
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;

// REST: 仅启停。
export const ScheduleEnabledRequest = z.object({ enabled: z.boolean() });
export type ScheduleEnabledRequest = z.infer<typeof ScheduleEnabledRequest>;

// 任务视图 = 服务端落盘形状（无敏感字段，同 TaskRecord extends TaskView 先例）。
export const ScheduleView = z.object({
  schedule_id: z.string(),
  owner: z.string(),
  name: z.string(),
  prompt: z.string(),
  agent_id: z.string(),
  time: ScheduleTime,
  enabled: z.boolean(),
  session_id: z.string().nullable(), // null = 尚未触发过（首触自动建专属会话）
  created_at: z.string(),
  updated_at: z.string(),
  next_run_at: z.string().nullable(), // null = 已停用 / once 已消耗
  last_run_at: z.string().nullable(),
  last_result: z.enum(["fired", "skipped"]).nullable(),
  last_skip_reason: z.enum(["owner_offline", "session_busy", "user_disabled"]).nullable(),
  missed_count: z.number().int(),
  run_count: z.number().int(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;

export const SchedulesResponse = z.object({ schedules: z.array(ScheduleView) });
export type SchedulesResponse = z.infer<typeof SchedulesResponse>;

// WS: 定时任务变更（创建/更新/启停/触发/跳过/自动停用/会话重建）推给任务主人。
export const WsScheduleUpdate = z.object({
  type: z.literal("schedule_update"),
  schedule: ScheduleView,
  // 触发时新建了专属会话（或会话被删后重建）时携带，客户端补进侧边栏。
  session: SessionMeta.optional(),
});
export type WsScheduleUpdate = z.infer<typeof WsScheduleUpdate>;
