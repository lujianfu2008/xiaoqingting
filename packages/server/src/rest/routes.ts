import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/AgentManager.js";
import type { Store } from "../store.js";
import type { ScheduleScheduler } from "../scheduler.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { registerSessionRoutes } from "./sessionRoutes.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { registerUpdateRequestRoutes } from "./updateRequestRoutes.js";
import { registerTaskRoutes } from "./taskRoutes.js";
import { registerLlmRoutes } from "./llmRoutes.js";
import { registerAsrRoutes } from "./asrRoutes.js";
import { registerMcpRoutes } from "./mcpRoutes.js";
import { registerSkillRoutes } from "./skillRoutes.js";
import { registerWorkflowRoutes } from "./workflowRoutes.js";
import { registerScheduleRoutes } from "./scheduleRoutes.js";
import { registerRelayRoutes } from "./relayRoutes.js";
import { registerDownloadRoutes } from "./downloadRoutes.js";
import { registerAttachmentRoutes } from "./attachmentRoutes.js";

// Composes the REST surface. Auth goes first because it also installs the JWT
// onRequest hook that protects every route registered after it.

export function registerRoutes(
  app: FastifyInstance,
  manager: AgentManager,
  store: Store,
  scheduler: ScheduleScheduler,
): void {
  registerAuthRoutes(app, manager);
  registerSessionRoutes(app, manager);
  registerAdminRoutes(app, manager);
  registerUpdateRequestRoutes(app, manager);
  registerTaskRoutes(app, manager);
  registerLlmRoutes(app, manager);
  registerAsrRoutes(app);
  registerMcpRoutes(app, manager);
  registerSkillRoutes(app, manager);
  registerWorkflowRoutes(app, manager);
  registerScheduleRoutes(app, manager, scheduler);
  registerRelayRoutes(app, manager);
  // 共享会话附件托管（上传/下载，字节随会话生命周期）。
  registerAttachmentRoutes(app, store);
  // 更新包分发（/download/:file，白名单目录；免鉴权，登录前也能检查更新）。
  registerDownloadRoutes(app);
}

// Fastify request augmentation
declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export type { Store };
