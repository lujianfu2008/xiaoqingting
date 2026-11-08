import type { WebSocket } from "ws";
import { ClientMessage, type ServerMessage } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { verifyToken } from "../auth.js";
import { isDisabled, isPublicAdmin, getStatus, getPasswordChangedAt, canReview, countPendingUsers } from "../users.js";

// WS endpoint: /ws?token=<jwt>
export function handleConnection(
  socket: WebSocket,
  req: { url?: string },
  manager: AgentManager,
): void {
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

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const unregister = manager.registerConnection(payload.uid, send, () =>
    socket.close(4003, "account_disabled"),
  );

  // 协议层探活：客户端对 ping 帧自动回 pong（应用层无感知）。判定死链
  // （休眠恢复/断网/丢包后的半开连接）直接 terminate，触发 unregister，
  // presence 不再显示假在线，也不再往死 socket 里写数据。
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

  // 公有域管理员上线：补推当前待审申请（持久化即投递，WS 只是实时提醒）。
  if (isPublicAdmin(payload.uid)) {
    for (const request of manager.listUpdateRequests(payload.uid, "pending")) {
      send({ type: "update_request", request });
    }
  }

  // 审核员/管理员上线：补推当前待审核注册数。
  if (canReview(payload.uid)) {
    send({ type: "review_request", pending: countPendingUsers() });
  }

  // 协作流任务补推：未完结任务（与 REST 播种双保险，upsert 幂等）。
  for (const task of manager.activeTasksFor(payload.uid)) {
    send({ type: "task_update", task });
  }

  socket.on("message", (raw: unknown) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const msg = ClientMessage.safeParse(parsed);
    if (!msg.success) return;

    switch (msg.data.type) {
      case "user_message":
        manager.handleUserMessage(
          payload.uid,
          msg.data.session_id,
          msg.data.text,
          msg.data.client_msg_id,
        );
        break;
      case "interrupt":
        manager.handleInterrupt(payload.uid, msg.data.session_id);
        break;
      case "permission_response":
        manager.handlePermissionResponse(payload.uid, msg.data.request_id, msg.data.allow);
        break;
      case "tool_exec_result":
        manager.handleToolExecResult(
          payload.uid,
          msg.data.request_id,
          {
            ok: msg.data.ok,
            output: msg.data.output,
            error: msg.data.error,
            images: msg.data.images,
          },
        );
        break;
      case "ping":
        socket.send(JSON.stringify({ type: "pong" }));
        break;
    }
  });

  const cleanup = () => {
    clearInterval(liveness);
    unregister();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
