import type { WebSocket } from "ws";
import { ClientMessage, type ServerMessage } from "@blm/protocol";
import type { AgentManager } from "../agent/AgentManager.js";
import { verifyToken } from "../auth.js";
import { isDisabled, isPublicAdmin } from "../users.js";

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

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const unregister = manager.registerConnection(payload.uid, send, () =>
    socket.close(4003, "account_disabled"),
  );

  // 公有域管理员上线：补推当前待审申请（持久化即投递，WS 只是实时提醒）。
  if (isPublicAdmin(payload.uid)) {
    for (const request of manager.listUpdateRequests(payload.uid, "pending")) {
      send({ type: "update_request", request });
    }
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
        manager.handleUserMessage(payload.uid, msg.data.session_id, msg.data.text);
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

  socket.on("close", unregister);
  socket.on("error", unregister);
}
