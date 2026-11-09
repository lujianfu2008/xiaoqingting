import "./engineSilence.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config, ensureDataDirs } from "./config.js";
import { AgentManager } from "./agent/AgentManager.js";
import { Store } from "./store.js";
import { ScheduleScheduler } from "./scheduler.js";
import { registerRoutes } from "./rest/routes.js";
import { handleConnection } from "./ws/handler.js";
import { handleRelayConnection } from "./ws/relayHandler.js";
import { setRelayProxyResolver, startRelayIngress } from "./relay/llmBridge.js";
import { startOpenAiCompatServer } from "./openaiCompat.js";

async function main(): Promise<void> {
  ensureDataDirs();
  const store = new Store();
  const manager = new AgentManager(store);
  // 存量任务迁移到 v2 模板快照表示（幂等；先于一切 REST/WS 入口）。
  manager.migrateLegacyTasks();
  // 定时任务调度器：持久化 next_run_at，重启后首 tick 自然恢复。
  const scheduler = new ScheduleScheduler(manager, store);
  scheduler.start();

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });
  // relay 通道的帧携带长上下文 LLM 请求体，上限放宽（普通聊天通道不受影响）。
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  registerRoutes(app, manager, store, scheduler);

  app.get("/ws", { websocket: true }, (socket, req) => {
    handleConnection(socket, req, manager);
  });

  app.get("/ws/relay", { websocket: true }, (socket, req) => {
    handleRelayConnection(socket, req);
  });

  app.get("/health", () => ({ ok: true }));

  // OpenAI 协议适配层：共享翻译端口，会话构建时 env 注入依赖它就绪。
  await startOpenAiCompatServer();

  // 网络中继：共享入口端口承载所有会话（主人在路径里），代发人逐请求解析。
  // 「当前负责人」由 AgentManager 晚绑定注入——relay 层不依赖 agent 层。
  await startRelayIngress();
  setRelayProxyResolver((sid) => manager.executorOf(sid));

  await app.listen({ port: config.port, host: config.host });
  console.log(`小蜻蜓服务端已启动: http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error("服务启动失败:", err);
  process.exit(1);
});
