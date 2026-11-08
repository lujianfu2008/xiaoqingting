import type { FastifyInstance } from "fastify";
import { RelayConfigUpdate } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import {
  getRelayOptIn,
  loadRelayConfig,
  saveRelayConfig,
  setRelayOptIn,
} from "../relay/relayConfig.js";
import { failAllPending, failPendingForProxy } from "../relay/llmBridge.js";
import { relayRegistry } from "../relay/registry.js";

// 网络中继（消息级 LLM 桥）的 REST 端点。
// 用户侧（/api/me/relay）：只有 opt-in 一个布尔——借出本机网络必须自愿。
// 入口端口是常驻共享的（启动即监听），opt-in 只影响「能否被选为代发人」，
// 不需要按用户建/关端口；退出时立刻失败其代为转发的在途请求。
// 管理侧（/api/admin/relay/config）：总开关，写审计；翻转影响引擎 env 注入，
// 丢弃全部空闲会话让下一条消息重建（与 MCP 全局变更同款）。

function myRelayStatus(userId: string) {
  return {
    opt_in: getRelayOptIn(userId),
    master_enabled: loadRelayConfig().enabled,
    relay_online: relayRegistry.isRelayOnline(userId),
  };
}

export function registerRelayRoutes(app: FastifyInstance, manager: AgentManager): void {
  // ---------- 用户侧 ----------

  app.get("/api/me/relay", (req) => myRelayStatus(req.userId));

  app.put("/api/me/relay", (req, reply) => {
    // 只接受 { opt_in: boolean }——用户侧没有别的可配项。
    const body = (req.body ?? {}) as { opt_in?: unknown };
    if (typeof body.opt_in !== "boolean") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    setRelayOptIn(req.userId, body.opt_in);
    // 入口端口常驻，opt-in 只改变「谁可作为代发人」；退出时立即失败该用户
    // 正在代为转发的在途请求，别让引擎干等到超时。
    if (!body.opt_in) {
      failPendingForProxy(req.userId, 503, "网络中继已停用：桌面端不再代为转发");
    }
    // env 在会话创建时固定：丢弃空闲会话，下一条消息按新状态重建。
    manager.disposeIdleSessions(req.userId);
    return myRelayStatus(req.userId);
  });

  // ---------- 管理侧 ----------

  app.get("/api/admin/relay/config", (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const cfg = loadRelayConfig();
    return {
      enabled: cfg.enabled,
      updated_at: cfg.updated_at,
      stats: relayRegistry.stats(),
    };
  });

  app.put("/api/admin/relay/config", async (req, reply) => {
    if (!isPublicAdmin(req.userId)) return reply.code(403).send({ error: "forbidden" });
    const parsed = RelayConfigUpdate.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const before = loadRelayConfig().enabled;
    const cfg = saveRelayConfig(parsed.data);
    appendAudit({
      actor: req.userId,
      action: "relay.config_save",
      target: "-",
      detail: { enabled: cfg.enabled },
    });
    // 总开关翻转影响 env 注入：关闭时立刻失败全部在途中继请求（入口不再可用），
    // 空闲会话一并丢弃；开启时无需预建任何东西——入口常驻，代发人逐请求选。
    if (!cfg.enabled && before) {
      failAllPending(503, "网络中继已被管理员关闭");
    }
    if (before !== cfg.enabled) manager.disposeAllIdleSessions();
    return {
      enabled: cfg.enabled,
      updated_at: cfg.updated_at,
      stats: relayRegistry.stats(),
    };
  });
}
