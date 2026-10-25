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
