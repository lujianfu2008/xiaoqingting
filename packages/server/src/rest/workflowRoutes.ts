import type { FastifyInstance } from "fastify";
import { UpsertWorkflowRequest, WorkflowName, type WorkflowInfo } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import {
  RESERVED_WORKFLOW_NAMES,
  deleteGlobalTemplate,
  deleteUserTemplate,
  loadGlobalTemplates,
  mergeWorkflows,
  saveGlobalTemplates,
  setUserTemplate,
} from "../workflowConfig.js";

// 工作流模板管理端点（模板名即主键，同名个人覆盖全局）。
// 用户级（/api/workflows/*）：本人模板 CRUD；全局（/api/admin/workflows/*）：
// 仅公有域管理员，写入写审计。模板只有环节序列与预置负责人，无敏感字段。

function validName(name: string): boolean {
  return WorkflowName.safeParse(name).success && !RESERVED_WORKFLOW_NAMES.has(name);
}

export function registerWorkflowRoutes(app: FastifyInstance, manager: AgentManager): void {
  void manager; // 与其他 register* 同签名；模板变更不影响引擎会话

  // ---------- 用户级 ----------

  // 生效视图（内置 + 全局 + 我的，同名以我的为准）。
  app.get("/api/workflows", (req) => ({
    workflows: mergeWorkflows(req.userId).workflows,
  }));

  app.put("/api/workflows/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertWorkflowRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return setUserTemplate(req.userId, name, parsed.data);
  });

  app.delete("/api/workflows/:name", (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!deleteUserTemplate(req.userId, name)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });

  // ---------- 全局（仅公有域管理员，存 data/workflow-templates.json） ----------

  app.get("/api/admin/workflows", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const workflows = Object.entries(loadGlobalTemplates())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tpl]) => ({
        name,
        ...(tpl.description ? { description: tpl.description } : {}),
        stages: tpl.stages,
        source: "global" as const,
        updated_at: tpl.updated_at,
      }));
    return { workflows };
  });

  app.put("/api/admin/workflows/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!validName(name)) return reply.code(400).send({ error: "invalid_name" });
    const parsed = UpsertWorkflowRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const map = loadGlobalTemplates();
    map[name] = {
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      stages: parsed.data.stages,
      updated_at: new Date().toISOString(),
    };
    saveGlobalTemplates(map);
    // 审计只记名称与环节清单，不含内容全文。
    appendAudit({
      actor: req.userId,
      action: "workflow.global_save",
      target: name,
      detail: { stages: parsed.data.stages.map((s) => s.name) },
    });
    return {
      name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      stages: parsed.data.stages,
      source: "global" as const,
    };
  });

  app.delete("/api/admin/workflows/:name", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const name = (req.params as { name: string }).name;
    if (!deleteGlobalTemplate(name)) {
      return reply.code(404).send({ error: "not_found" });
    }
    appendAudit({ actor: req.userId, action: "workflow.global_delete", target: name });
    return reply.code(204).send();
  });
}
