import type { FastifyInstance } from "fastify";
import { CreateTaskRequest, TaskFlowRequest, TasksResponse } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { TaskCreateError } from "../agent/taskManager.js";

// 团队协作流（可自定义工作流模板）：任务线程的创建 / 我的列表 / 流转。
// 鉴权矩阵执法在 TaskManager.flow，这里只做协议校验与错误码映射。

export function registerTaskRoutes(app: FastifyInstance, manager: AgentManager): void {
  // 创建任务线程：同时建一个同名绑定会话，返回任务视图。
  app.post("/api/tasks", (req, reply) => {
    const parsed = CreateTaskRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const rec = manager.createTask(req.userId, {
        title: parsed.data.title.trim(),
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(parsed.data.agent_id ? { agent_id: parsed.data.agent_id } : {}),
        ...(parsed.data.template_name ? { template_name: parsed.data.template_name } : {}),
        ...(parsed.data.assignees ? { assignees: parsed.data.assignees } : {}),
      });
      return reply.code(201).send(rec);
    } catch (e) {
      if (e instanceof TaskCreateError) return reply.code(400).send({ error: e.code });
      throw e;
    }
  });

  // 我的任务列表（需求方/任一环节负责人命中）。
  app.get("/api/tasks", (req) => {
    const body: TasksResponse = { tasks: manager.listTasks(req.userId) };
    return body;
  });

  // 推进流转（动作/状态/角色守卫在 TaskManager）。
  app.post("/api/tasks/:id/flow", (req, reply) => {
    const parsed = TaskFlowRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = manager.flowTask(req.userId, (req.params as { id: string }).id, {
      action: parsed.data.action,
      ...(parsed.data.target != null ? { target: parsed.data.target } : {}),
      ...(parsed.data.stage_key != null ? { stage_key: parsed.data.stage_key } : {}),
      ...(parsed.data.note != null ? { note: parsed.data.note } : {}),
    });
    if (!result.ok) {
      const codes = {
        not_found: 404,
        forbidden: 403,
        bad_status: 409,
        bad_target: 400,
        bad_request: 400,
      } as const;
      return reply.code(codes[result.code]).send({ error: result.code, message: result.message });
    }
    return result.rec;
  });

  // 删除已完结的任务记录（需求方；含绑定会话已删的幽灵灰显条目）。
  app.delete("/api/tasks/:id", (req, reply) => {
    const result = manager.deleteTask(req.userId, (req.params as { id: string }).id);
    if (result === "ok") return reply.code(204).send();
    const codes = {
      not_found: 404,
      forbidden: 403,
      bad_status: 409,
    } as const;
    const messages = {
      not_found: "任务不存在。",
      forbidden: "只有需求方可以删除任务记录。",
      bad_status: "任务未完结，先取消或删除任务线程。",
    } as const;
    return reply
      .code(codes[result])
      .send({ error: result, message: messages[result] });
  });
}
