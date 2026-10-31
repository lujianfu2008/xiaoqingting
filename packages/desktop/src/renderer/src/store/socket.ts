// Module-scoped WebSocket state shared by the connection / chat actions.
// Kept outside the zustand store so reconnects and raw sends never trigger
// React re-renders.

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUser = false;

export function currentSocket(): WebSocket | null {
  return ws;
}

export function setSocket(next: WebSocket | null): void {
  ws = next;
}

export function socketOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function sendJson(payload: unknown): void {
  if (!socketOpen()) return;
  ws!.send(JSON.stringify(payload));
}

export function resetReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

export function setReconnectTimer(t: ReturnType<typeof setTimeout> | null): void {
  reconnectTimer = t;
}

export function nextReconnectDelay(): number {
  // exponential backoff, capped at 30s — avoid hammering an unreachable server
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000);
  reconnectAttempt++;
  return delay;
}

export function resetReconnectAttempt(): void {
  reconnectAttempt = 0;
}

export function setClosedByUser(v: boolean): void {
  closedByUser = v;
}

export function isClosedByUser(): boolean {
  return closedByUser;
}

export function sendExecResult(
  requestId: string,
  result: { ok: boolean; output?: string; error?: string; images?: { media_type: string; data: string }[] },
): void {
  sendJson({ type: "tool_exec_result", request_id: requestId, ...result });
}

// ---------- 心跳探活 ----------
// 休眠恢复/断网/丢包会留下"半开连接"：readyState 仍是 OPEN 但链路已死，
// 发消息石沉大海。定期发应用层 ping，任何入站消息（含 pong）都算存活；
// 超时未收到就主动 close，让 onclose 里的重连逻辑接手。

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

let hbWs: WebSocket | null = null;
let hbInterval: ReturnType<typeof setInterval> | null = null;
let hbTimeout: ReturnType<typeof setTimeout> | null = null;

/** Start the liveness loop for one socket (called from onopen). */
export function startHeartbeat(ws: WebSocket, onDead?: () => void): void {
  stopHeartbeat();
  hbWs = ws;
  hbInterval = setInterval(() => {
    if (hbWs !== ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    sendJson({ type: "ping" });
    if (hbTimeout) clearTimeout(hbTimeout);
    hbTimeout = setTimeout(() => {
      if (hbWs !== ws) return;
      stopHeartbeat();
      // 半开连接上 close 握手本身也可能发不出去、onclose 迟迟不来：
      // 先 close，再直接走断链逻辑（onDead），由 connect() 用新 socket
      // 替换这个 CLOSING 的旧壳，不依赖 onclose 兜底。
      try {
        ws.close();
      } catch {
        // already closing
      }
      onDead?.();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

/** Any inbound message proves the link is alive (called from onmessage). */
export function markSocketAlive(): void {
  if (hbTimeout) {
    clearTimeout(hbTimeout);
    hbTimeout = null;
  }
}

export function stopHeartbeat(): void {
  hbWs = null;
  if (hbInterval) {
    clearInterval(hbInterval);
    hbInterval = null;
  }
  if (hbTimeout) {
    clearTimeout(hbTimeout);
    hbTimeout = null;
  }
}

/** True when this socket is still the active one (stale-socket guard). */
export function isActiveSocket(ws: WebSocket): boolean {
  return ws === currentSocket();
}

// ---------- 发送确认（ack） ----------
// user_message 发出后等服务端回显 user_text 块作为送达确认；断线/半开时
// 消息丢失则超时（或断线即刻）触发 onFail：提示 + 复位 busy + 文本放回输入框。

const SEND_ACK_TIMEOUT_MS = 15_000;

const pendingAcks = new Map<string, { timer: ReturnType<typeof setTimeout>; onFail: () => void }>();

export function armSendAck(sessionId: string, onFail: () => void): void {
  clearSendAck(sessionId);
  const timer = setTimeout(() => {
    pendingAcks.delete(sessionId);
    onFail();
  }, SEND_ACK_TIMEOUT_MS);
  pendingAcks.set(sessionId, { timer, onFail });
}

export function clearSendAck(sessionId: string): void {
  const p = pendingAcks.get(sessionId);
  if (p) {
    clearTimeout(p.timer);
    pendingAcks.delete(sessionId);
  }
}

/** Abnormal disconnect: fail every in-flight send immediately with feedback. */
export function failPendingAcks(): void {
  const fails = [...pendingAcks.values()];
  pendingAcks.clear();
  for (const p of fails) {
    clearTimeout(p.timer);
    p.onFail();
  }
}
