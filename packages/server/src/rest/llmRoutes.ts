import type { FastifyInstance } from "fastify";
import { UpdateLlmConfigRequest } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import {
  describeLlmConfig,
  setUserLlmConfig,
  clearUserLlmConfig,
} from "../llmConfig.js";

// Per-user LLM settings. Writes drop the user's idle agent sessions so the next
// message restarts with the new settings.

export function registerLlmRoutes(
  app: FastifyInstance,
  manager: AgentManager,
): void {
  app.get("/api/llm-config", (req) => describeLlmConfig(req.userId));

  app.put("/api/llm-config", (req, reply) => {
    const parsed = UpdateLlmConfigRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const info = setUserLlmConfig(req.userId, parsed.data);
    // Restart idle sessions so the next message uses the new settings.
    manager.disposeIdleSessions(req.userId);
    return info;
  });

  app.delete("/api/llm-config", (req, reply) => {
    clearUserLlmConfig(req.userId);
    manager.disposeIdleSessions(req.userId);
    return reply.code(204).send();
  });
}
