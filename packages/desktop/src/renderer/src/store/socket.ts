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
  // 半开连接上 OS 发送缓冲会只积不清：先看队列水位，堆积说明
  // 链路已死（正常情况下 WS 帧极小、即刻排空），别把消息推进
  // 黑洞——让上层走失败路径（放回输入框）而不是等 15s ack 超时。
  if (ws!.bufferedAmount > 64 * 1024) {
    try {
      ws!.close();
    } catch {
      // already closing
    }
    return;
  }
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
// 消息丢失则触发 onFail：警告 + 复位 busy + 文本放回输入框。
// 按 client_msg_id 记账：回合进行中连发补充消息时多条同时在途，单槽位会
// 互相覆盖（后发那条把先发那条的确认顶掉）。
//
// 自动重发（网络抖动容忍）：在途消息可重试 sendRetryCount 次，每次失败
// （ack 超时）用**同一个 client_msg_id** 重发——服务端按该 id 幂等去重，
// 网络抖动正好把回显弄丢时不会跑出两条回复（见 messageRouter 去重）。
// 剩余重试次数耗尽才真正失败（放回输入框）。断线时暂停计时，重连成功后
// 统一重发仍在途的消息（每次重发消耗一条预算，flap 下发送次数也有限）。

const SEND_ACK_TIMEOUT_MS = 15_000;

const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 5;

/** 当前生效的自动重试次数（0 = 关闭）。由 store 初始化时注入。 */
let sendRetries = DEFAULT_RETRIES;
export function setSendRetries(n: number): void {
  sendRetries = Math.max(0, Math.min(MAX_RETRIES, Math.trunc(n)));
}

interface PendingAck {
  sessionId: string;
  text: string;
  /** 剩余重试次数（含本次，被 onFail 消耗；用尽才真正失败）。 */
  retriesLeft: number;
  /** 断线暂停期间的计时器状态。是在途/待发，但已暂停计时。 */
  paused: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onFail: () => void;
}

const pendingAcks = new Map<string, PendingAck>();

export function armSendAck(
  msgId: string,
  sessionId: string,
  text: string,
  onFail: () => void,
): void {
  clearSendAck(msgId);
  const entry: PendingAck = {
    sessionId,
    text,
    retriesLeft: sendRetries,
    paused: false,
    timer: null,
    onFail,
  };
  armTimer(entry);
  pendingAcks.set(msgId, entry);
}

function armTimer(entry: PendingAck): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.paused = false;
  entry.timer = setTimeout(() => {
    if (pendingAcks.get(currentMsgIdOf(entry)) !== entry) return;
    // 计时到点但链路已不在线（半开判定的 finally 间隙）：不烧重试预算，
    // 只是重新计时等 suspend 接管；suspendAcks 会 clear 这个 timer。
    // 用户主动登出/关闭的情况例外：不再重连，直接放弃这条在途消息
    // （登出已清空界面状态，无需再退回——退也没处退了）。
    if (!socketOpen()) {
      if (isClosedByUser()) {
        pendingAcks.delete(currentMsgIdOf(entry));
        return;
      }
      armTimer(entry);
      return;
    }
    entry.timer = null;
    const msgId = currentMsgIdOf(entry);
    if (entry.retriesLeft > 0) {
      // 仍有预算：同一 client_msg_id 重发，服务端幂等（绝不双跑）。
      entry.retriesLeft--;
      sendJson({
        type: "user_message",
        session_id: entry.sessionId,
        text: entry.text,
        client_msg_id: msgId,
      });
      armTimer(entry);
      return;
    }
    // 预算耗尽：真正失败，退回输入框。
    pendingAcks.delete(msgId);
    entry.onFail();
  }, SEND_ACK_TIMEOUT_MS);
}

/** 单个消息 id → 该条 ack 记录的逆映射（计时器回调里取自己的 id）。 */
function currentMsgIdOf(entry: PendingAck): string {
  for (const [id, e] of pendingAcks) if (e === entry) return id;
  return "";
}

export function clearSendAck(msgId: string): void {
  const p = pendingAcks.get(msgId);
  if (p) {
    if (p.timer) clearTimeout(p.timer);
    pendingAcks.delete(msgId);
  }
}

/** 老服务端不回显 client_msg_id 时的兜底：按文本匹配解除该会话最早的一条。 */
export function clearSendAckByText(sessionId: string, text: string): void {
  for (const [id, p] of pendingAcks) {
    if (p.sessionId !== sessionId || p.text !== text) continue;
    clearSendAck(id);
    return;
  }
}

/** 该会话还在等确认的发送条数（>0 表示本地还有消息没被服务端接手）。 */
export function pendingAcksForSession(sessionId: string): number {
  let n = 0;
  for (const p of pendingAcks.values()) if (p.sessionId === sessionId) n++;
  return n;
}

/** 全部 ack 解除（登出/重置用）。不回退草稿——登出本就清界面状态。 */
export function clearAllAcks(): void {
  for (const p of pendingAcks.values()) {
    if (p.timer) clearTimeout(p.timer);
  }
  pendingAcks.clear();
}

/** 断线：暂停所有在途 ack 的计时（不烧预算），等重连后重发。 */
export function suspendAcks(): void {
  for (const p of pendingAcks.values()) {
    if (p.timer) clearTimeout(p.timer);
    p.paused = true;
    p.timer = null;
  }
}

/** 重连成功：把暂停中的在途消息用同一 client_msg_id 重发，重新走计时。
 *  每次重发（含断线重连重发）都消耗一条重试预算——预算即"首条之后最多再
 *  发几次"的用户设定，保证在持续断线重连（flap）下总发送次数也有限，绝不
 *  无限重发。预算已用尽的条目直接失败退回输入框。 */
export function resumeAcks(): void {
  for (const [msgId, p] of pendingAcks) {
    if (!p.paused) continue;
    if (p.retriesLeft <= 0) {
      pendingAcks.delete(msgId);
      p.onFail();
      continue;
    }
    p.paused = false;
    p.retriesLeft--;
    sendJson({
      type: "user_message",
      session_id: p.sessionId,
      text: p.text,
      client_msg_id: msgId,
    });
    armTimer(p);
  }
}

/** Abnormal disconnect: fail every in-flight send immediately with feedback.
 *  （已改造成 suspend-on-disconnect；此函数保留给显式放弃路径调用，常规不触发。） */
export function failPendingAcks(): void {
  const fails = [...pendingAcks.values()];
  pendingAcks.clear();
  for (const p of fails) {
    if (p.timer) clearTimeout(p.timer);
    p.onFail();
  }
}

