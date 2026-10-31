import type { WebSocket } from "ws";
import { RelayClientMessage } from "@blm/protocol";
import { verifyToken } from "../auth.js";
import { isDisabled, getStatus, getPasswordChangedAt } from "../users.js";
import { relayRegistry } from "../relay/registry.js";
import { handleRelayClientMessage, failPendingOnRelayDrop } from "../relay/llmBridge.js";

// WS endpoint: /ws/relay?token=<jwt> —— 桌面端 main 进程的中继专用连接。
// 四道闸与聊天 /ws 相同，但消息是桥接帧（RelayClientMessage：llm_response_*）：
// 定向投递给该用户的唯一 relay 连接，永不进入聊天通道的 ConnectionRegistry
// 广播语义。路由注册处 maxPayload 提到 64MiB（长上下文请求体可达数 MB）。

export function handleRelayConnection(socket: WebSocket, req: { url?: string }): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const payload = verifyToken(url.searchParams.get("token") ?? "");
  if (!payload) {
    socket.close(4001, "unauthorized");
    return;
  }
  // 被禁用的账号不允许建立连接。
  if (isDisabled(payload.uid)) {
    socket.close(4003, "account_disabled");
    return;
  }
  // 未过审（待审核/已拒绝）的账号同样拒连（防旧 token 继续使用）。
  const status = getStatus(payload.uid);
  if (status !== "approved") {
    socket.close(4004, status === "pending" ? "pending_review" : "review_rejected");
    return;
  }
  // 改密前签发的 token 已过期，要求重新登录。
  const pwc = getPasswordChangedAt(payload.uid);
  if (pwc !== null && payload.iat !== undefined && payload.iat < pwc) {
    socket.close(4001, "token_stale");
    return;
  }

  const unregister = relayRegistry.register(payload.uid, socket);

  // 协议层探活（与 /ws 同款）：判定死链直接 terminate。
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const liveness = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      // socket closing — the close handler cleans up
    }
  }, 30_000);
  liveness.unref();

  socket.on("message", (raw: unknown) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const msg = RelayClientMessage.safeParse(parsed);
    if (!msg.success) return; // 非法/未知帧一律丢弃
    handleRelayClientMessage(payload.uid, msg.data);
  });

  const cleanup = () => {
    clearInterval(liveness);
    unregister();
    // 中继真离线：在途 LLM 请求立刻失败（503/SSE error），不等 300s 无数据
    // 超时。superseded 顶替不算离线——新连接已接管时 isRelayOnline 仍为 true。
    if (!relayRegistry.isRelayOnline(payload.uid)) failPendingOnRelayDrop(payload.uid);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
