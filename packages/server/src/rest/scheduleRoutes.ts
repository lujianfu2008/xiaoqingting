import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  CreateScheduleRequest,
  ScheduleEnabledRequest,
  UpdateScheduleRequest,
} from "@blm/protocol";
import type { ScheduleView } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { listRoles } from "../agent/agents.js";
import type { ScheduleScheduler } from "../scheduler.js";
import { computeNextRunAt } from "../scheduler.js";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  saveSchedule,
  scheduleNameTaken,
  type ScheduleRecord,
} from "../scheduleStore.js";

// 定时任务管理端点（本人 CRUD + 启停 + 手动触发）。所有权检查：路径 id 一律
// 经 getSchedule(req.userId, id)（owner 不符与不存在同样 404，掩盖存在性）。
// 变更统一推 schedule_update 给主人（trigger 的推送在 scheduler.fire 内）。

function agentValid(agentId: string): boolean {
  return listRoles().some((r) => r.agent_id === agentId);
}

/** once 的计划就是 at 本身；recurring 从 from 向后算。 */
function nextRunAt(time: ScheduleView["time"], from: Date, anchorIso: string): string | null {
  return time.kind === "once" ? time.at : computeNextRunAt(time, from, anchorIso);
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  manager: AgentManager,
  scheduler: ScheduleScheduler,
): void {
  void manager; // 与其他 register* 同签名；触发走 scheduler（内部持 manager）

  app.get("/api/schedules", (req) => ({ schedules: listSchedules(req.userId) }));

  app.post("/api/schedules", (req, reply) => {
    const parsed = CreateScheduleRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!agentValid(parsed.data.agent_id)) return reply.code(400).send({ error: "invalid_agent" });
    if (scheduleNameTaken(req.userId, parsed.data.name)) {
      return reply.code(400).send({ error: "name_taken" });
    }
    const now = new Date();
    const rec: ScheduleRecord = {
      schedule_id: randomUUID(),
      owner: req.userId,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      agent_id: parsed.data.agent_id,
      time: parsed.data.time,
      enabled: parsed.data.enabled ?? true,
      session_id: null, // 首触自动建专属会话
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      // once 时间已过不拒绝：首 tick 命中后在线补跑一轮 / 离线记错过停用。
      next_run_at: parsed.data.enabled === false ? null : nextRunAt(parsed.data.time, now, now.toISOString()),
      last_run_at: null,
      last_result: null,
      last_skip_reason: null,
      missed_count: 0,
      run_count: 0,
    };
    saveSchedule(rec);
    scheduler.notify(rec);
    return reply.code(201).send(rec);
  });

  app.put("/api/schedules/:id", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = getSchedule(req.userId, id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    const parsed = UpdateScheduleRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!agentValid(parsed.data.agent_id)) return reply.code(400).send({ error: "invalid_agent" });
    if (scheduleNameTaken(req.userId, parsed.data.name, id)) {
      return reply.code(400).send({ error: "name_taken" });
    }
    const now = new Date();
    const next: ScheduleRecord = {
      ...rec,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      agent_id: parsed.data.agent_id,
      time: parsed.data.time,
      enabled: parsed.data.enabled,
      updated_at: now.toISOString(),
      // 编辑即重排计划（once 重挂回 at；停用状态保持 null）。
      next_run_at: parsed.data.enabled ? nextRunAt(parsed.data.time, now, rec.created_at) : null,
    };
    saveSchedule(next);
    scheduler.notify(next);
    return next;
  });

  app.post("/api/schedules/:id/enabled", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = getSchedule(req.userId, id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    const parsed = ScheduleEnabledRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const now = new Date();
    const next: ScheduleRecord = {
      ...rec,
      enabled: parsed.data.enabled,
      updated_at: now.toISOString(),
      // 启用即重排（once 重挂回 at，已消耗的 once 再启用会立刻补跑一轮——语义同手动触发）；停用清空。
      next_run_at: parsed.data.enabled ? nextRunAt(rec.time, now, rec.created_at) : null,
    };
    saveSchedule(next);
    scheduler.notify(next);
    return next;
  });

  app.post("/api/schedules/:id/trigger", (req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = scheduler.triggerNow(req.userId, id);
    if (!res.ok) return reply.code(res.code === "not_found" ? 404 : 403).send({ error: res.code });
    return res.rec;
  });

  app.delete("/api/schedules/:id", (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deleteSchedule(req.userId, id)) return reply.code(404).send({ error: "not_found" });
    // 不推送：操作端 204 后本地移除，其余端靠 onopen REST 播种收敛（同 sessions delete）。
    return reply.code(204).send();
  });
}
