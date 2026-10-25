import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config, ensureDataDirs } from "./config.js";
import { AgentManager } from "./agent/AgentManager.js";
import { Store } from "./store.js";
import { registerRoutes } from "./rest/routes.js";
import { handleConnection } from "./ws/handler.js";

async function main(): Promise<void> {
  ensureDataDirs();
  const store = new Store();
  const manager = new AgentManager(store);

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  registerRoutes(app, manager, store);

  app.get("/ws", { websocket: true }, (socket, req) => {
    handleConnection(socket, req, manager);
  });

  app.get("/health", () => ({ ok: true }));

  await app.listen({ port: config.port, host: config.host });
  console.log(`小蜻蜓服务端已启动: http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error("服务启动失败:", err);
  process.exit(1);
});
