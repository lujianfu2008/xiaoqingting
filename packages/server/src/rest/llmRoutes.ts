import type { FastifyInstance } from "fastify";
import {
  LlmProfileEnabledRequest,
  LlmReorderRequest,
  LlmSettingsPatch,
  UpdateLlmProfileRequest,
} from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import {
  clearUserLlmConfig,
  deleteLlmProfile,
  describeLlmConfig,
  reorderLlmProfiles,
  setLlmProfileEnabled,
  updateLlmSettings,
  upsertLlmProfile,
} from "../llmConfig.js";

// Per-user LLM settings：多配置（profiles，数组序 = 优先级）+ 调用策略
// （超时/重试/自动模型选择）。任何写操作都丢弃该用户的空闲会话，下一条
// 消息按新配置重建。

function fail(reply: { code(c: number): { send(o: unknown): unknown } }, err: unknown): unknown {
  const msg = err instanceof Error ? err.message : "";
  if (msg === "profile_not_found") return reply.code(404).send({ error: "not_found" });
  if (msg === "too_many_profiles") return reply.code(400).send({ error: "too_many_profiles" });
  if (msg === "empty_profile") return reply.code(400).send({ error: "empty_profile" });
  if (msg === "bad_order") return reply.code(400).send({ error: "bad_order" });
  return reply.code(500).send({ error: "internal" });
}

export function registerLlmRoutes(
  app: FastifyInstance,
  manager: AgentManager,
): void {
  app.get("/api/llm-config", (req) => describeLlmConfig(req.userId));

  // 新建/编辑一条配置（id 缺省 = 新建，排到列表末尾）。
  app.put("/api/llm-config/profile", (req, reply) => {
    const parsed = UpdateLlmProfileRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const info = upsertLlmProfile(req.userId, parsed.data);
      manager.disposeIdleSessions(req.userId);
      return info;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 启用/停用（停用的配置保留内容与优先级位置，只是不参与选型）。
  app.post("/api/llm-config/profile/:id/enabled", (req, reply) => {
    const parsed = LlmProfileEnabledRequest.safeParse(req.body ?? {});
    const id = (req.params as Record<string, string>).id;
    if (!parsed.success || !id) return reply.code(400).send({ error: "invalid_request" });
    try {
      const info = setLlmProfileEnabled(req.userId, id, parsed.data.enabled);
      manager.disposeIdleSessions(req.userId);
      return info;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 优先级重排（ids 必须给全现有配置）。
  app.post("/api/llm-config/reorder", (req, reply) => {
    const parsed = LlmReorderRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const info = reorderLlmProfiles(req.userId, parsed.data.ids);
      manager.disposeIdleSessions(req.userId);
      return info;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/api/llm-config/profile/:id", (req, reply) => {
    const id = (req.params as Record<string, string>).id;
    if (!id) return reply.code(400).send({ error: "invalid_request" });
    try {
      const info = deleteLlmProfile(req.userId, id);
      manager.disposeIdleSessions(req.userId);
      return info;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 调用策略：超时/重试次数/自动模型选择。
  app.put("/api/llm-config/settings", (req, reply) => {
    const parsed = LlmSettingsPatch.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const info = updateLlmSettings(req.userId, parsed.data);
    manager.disposeIdleSessions(req.userId);
    return info;
  });

  // 清空全部个人配置，回到服务器默认。
  app.delete("/api/llm-config", (req, reply) => {
    clearUserLlmConfig(req.userId);
    manager.disposeIdleSessions(req.userId);
    return reply.code(204).send();
  });
}
