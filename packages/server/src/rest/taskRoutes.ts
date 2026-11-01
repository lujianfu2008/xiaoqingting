import type { FastifyInstance } from "fastify";
import { CreateTaskRequest, TaskFlowRequest, TasksResponse } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";

// 团队协作流（需求 → 研发 → 测试）：任务线程的创建 / 我的列表 / 流转。
// 鉴权矩阵执法在 TaskManager.flow，这里只做协议校验与错误码映射。

export function registerTaskRoutes(app: FastifyInstance, manager: AgentManager): void {
  // 创建任务线程：同时建一个同名绑定会话，返回任务视图。
  app.post("/api/tasks", (req, reply) => {
    const parsed = CreateTaskRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const rec = manager.createTask(req.userId, {
      title: parsed.data.title.trim(),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.agent_id ? { agent_id: parsed.data.agent_id } : {}),
    });
    return reply.code(201).send(rec);
  });

  // 我的任务列表（需求方/研发/测试任一角色命中）。
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
}
