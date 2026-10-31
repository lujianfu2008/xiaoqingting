import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config, ensureDataDirs } from "./config.js";
import { AgentManager } from "./agent/AgentManager.js";
import { Store } from "./store.js";
import { registerRoutes } from "./rest/routes.js";
import { handleConnection } from "./ws/handler.js";
import { handleRelayConnection } from "./ws/relayHandler.js";
import { ensureBridgesAtStartup } from "./relay/llmBridge.js";
import { startOpenAiCompatServer } from "./openaiCompat.js";
import { getRelayOptInUsernames, loadRelayConfig } from "./relay/relayConfig.js";

async function main(): Promise<void> {
  ensureDataDirs();
  const store = new Store();
  const manager = new AgentManager(store);

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });
  // relay 通道的帧携带长上下文 LLM 请求体，上限放宽（普通聊天通道不受影响）。
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  registerRoutes(app, manager, store);

  app.get("/ws", { websocket: true }, (socket, req) => {
    handleConnection(socket, req, manager);
  });

  app.get("/ws/relay", { websocket: true }, (socket, req) => {
    handleRelayConnection(socket, req);
  });

  app.get("/health", () => ({ ok: true }));

  // OpenAI 协议适配层：共享翻译端口，会话构建时 env 注入依赖它就绪。
  await startOpenAiCompatServer();

  await app.listen({ port: config.port, host: config.host });
  console.log(`小蜻蜓服务端已启动: http://${config.host}:${config.port}`);

  // 网络中继：为已有 opt-in 用户预建 LLM 桥端口（引擎 env 注入依赖端口就绪）。
  if (loadRelayConfig().enabled) {
    await ensureBridgesAtStartup(getRelayOptInUsernames());
  }
}

main().catch((err) => {
  console.error("服务启动失败:", err);
  process.exit(1);
});
