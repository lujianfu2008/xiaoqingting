import type { FastifyInstance } from "fastify";
import { RelayConfigUpdate } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { appendAudit } from "../audit.js";
import { isPublicAdmin } from "../users.js";
import {
  getRelayOptIn,
  getRelayOptInUsernames,
  loadRelayConfig,
  saveRelayConfig,
  setRelayOptIn,
} from "../relay/relayConfig.js";
import { closeBridge, ensureBridge } from "../relay/llmBridge.js";
import { relayRegistry } from "../relay/registry.js";

// 网络中继（消息级 LLM 桥）的 REST 端点。
// 用户侧（/api/me/relay）：只有 opt-in 一个布尔——借出本机网络必须自愿；
// opt-in 时预建该用户的桥端口，退出时关闭。
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

  app.put("/api/me/relay", async (req, reply) => {
    // 只接受 { opt_in: boolean }——用户侧没有别的可配项。
    const body = (req.body ?? {}) as { opt_in?: unknown };
    if (typeof body.opt_in !== "boolean") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    setRelayOptIn(req.userId, body.opt_in);
    // 桥端口跟随 opt-in 生命周期（engine env 注入依赖端口就绪）。
    if (body.opt_in && loadRelayConfig().enabled) {
      try {
        await ensureBridge(req.userId);
      } catch (err) {
        console.error(`[relay] LLM 桥创建失败 user=${req.userId}:`, err);
        return reply.code(500).send({ error: "bridge_failed" });
      }
    } else if (!body.opt_in) {
      closeBridge(req.userId);
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
    // 总开关翻转影响 env 注入：开启时为所有 opt-in 用户预建桥，关闭时全关。
    if (cfg.enabled && !before) {
      for (const username of getRelayOptInUsernames()) {
        try {
          await ensureBridge(username);
        } catch (err) {
          console.error(`[relay] LLM 桥创建失败 user=${username}:`, err);
        }
      }
    } else if (!cfg.enabled && before) {
      for (const username of getRelayOptInUsernames()) closeBridge(username);
    }
    if (before !== cfg.enabled) manager.disposeAllIdleSessions();
    return {
      enabled: cfg.enabled,
      updated_at: cfg.updated_at,
      stats: relayRegistry.stats(),
    };
  });
}
