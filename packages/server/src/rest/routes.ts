import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/AgentManager.js";
import type { Store } from "../store.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { registerSessionRoutes } from "./sessionRoutes.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { registerUpdateRequestRoutes } from "./updateRequestRoutes.js";
import { registerLlmRoutes } from "./llmRoutes.js";
import { registerAsrRoutes } from "./asrRoutes.js";

// Composes the REST surface. Auth goes first because it also installs the JWT
// onRequest hook that protects every route registered after it.

export function registerRoutes(
  app: FastifyInstance,
  manager: AgentManager,
  store: Store,
): void {
  void store; // kept for the existing call signature in index.ts
  registerAuthRoutes(app);
  registerSessionRoutes(app, manager);
  registerAdminRoutes(app, manager);
  registerUpdateRequestRoutes(app, manager);
  registerLlmRoutes(app, manager);
  registerAsrRoutes(app);
}

// Fastify request augmentation
declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export type { Store };
