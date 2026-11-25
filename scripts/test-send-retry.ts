// 发送确认（ack）重试状态机的独立单测：验证 socket.ts 的自动重发预算逻辑。
// 真实发送链路（chat.send）：
//   sendJson(user_message, cid)  →  armSendAck(cid, sess, text, onFail)
// 本测试忠实复刻：先模拟 sendJson 发出首条，再 arm，然后假时钟推进。
// 用法：node --import tsx scripts/test-send-retry.ts
let pass = 0;
const checks: string[] = [];
const ok = (cond: boolean, label: string): void => {
  if (cond) pass++;
  checks.push(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) console.error("FAIL:", label);
};

// ---------- 假 WebSocket 与假时钟 ----------
class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWS.OPEN;
  bufferedAmount = 0;
  send: (data: string) => void = () => {};
}
(globalThis as Record<string, unknown>).WebSocket = FakeWS;

let now = 0;
let timers: { id: number; at: number; fn: () => void }[] = [];
let nextTimerId = 1;
(globalThis as Record<string, unknown>).setTimeout = (fn: () => void, ms: number) => {
  const id = nextTimerId++;
  timers.push({ id, at: now + ms, fn });
  return id;
};
(globalThis as Record<string, unknown>).clearTimeout = (id: unknown) => {
  timers = timers.filter((t) => t.id !== id);
};
const advance = (ms: number): void => {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
    if (due.length === 0) break;
    const t = due[0];
    timers = timers.filter((x) => x.id !== t.id);
    now = t.at;
    t.fn();
  }
  now = target;
};

const main = async (): Promise<void> => {
  const mod = await import("../packages/desktop/src/renderer/src/store/socket.ts");
  const fakeSocket = new FakeWS();
  mod.setSocket(fakeSocket as unknown as WebSocket);
  const sent: unknown[] = [];
  fakeSocket.send = (d: string) => sent.push(JSON.parse(d));
  const failLog: string[] = [];

  /** 复刻 chat.send：先真正发一条 user_message（首条），再 arm（等回显）。 */
  const sendAndArm = (cid: string, sess: string, text: string, label: string): void => {
    const userMsg = { type: "user_message", session_id: sess, text, client_msg_id: cid };
    sent.push(userMsg);
    mod.armSendAck(cid, sess, text, () => failLog.push(label));
  };
  const userMsgs = () => sent.filter((s) => (s as { type: string }).type === "user_message") as Array<{ client_msg_id: string }>;

  console.log("--- 场景 1：预算内超时 → 自动重发同 id ---");
  mod.setSendRetries(2);
  sendAndArm("msg1", "sessA", "hello", "msg1-fail");
  advance(15_000); // 首条后 15s 无回显 → 重发（budget 2→1）
  ok(userMsgs().length === 2, "15s 超时后同 id 自动重发（首条 + 重发）");
  ok(userMsgs()[0].client_msg_id === userMsgs()[1].client_msg_id, "两次发送用同一 client_msg_id");
  ok(failLog.length === 0, "预算未耗尽不触发失败回退");
  console.log("      发送序列 id:", userMsgs().map((m) => m.client_msg_id).join(","));

  // 回显到达：解除 ack（模拟 messages.ts clearSendAck）。
  mod.clearSendAck("msg1");
  ok(mod.pendingAcksForSession("sessA") === 0, "回显到达后 ack 解除");

  console.log("--- 场景 2：预算耗尽 → 真正失败 ---");
  sendAndArm("msg9", "sessB", "doomed", "msg9-fail");
  advance(15_000); // 重发（retriesLeft 2→1）
  advance(15_000); // 再超时 → 重发（retriesLeft 1→0）
  advance(15_000); // 再超时 → 预算耗尽 → fail
  ok(failLog.includes("msg9-fail"), "预算用尽后触发失败回退");
  ok(mod.pendingAcksForSession("sessB") === 0, "失败后该会话在途记录清空");
  ok(userMsgs().filter((m) => m.client_msg_id === "msg9").length === 3, "总共发送 3 次（首条+2 次重发）");

  console.log("--- 场景 3：断线挂起 → 重连续发（同 id、预算消耗） ---");
  sent.length = 0;
  failLog.length = 0;
  sendAndArm("msg2", "sessC", "extend", "msg2-fail");
  mod.suspendAcks(); // 模拟断线：暂停计时（不清在途）
  const beforeResume = userMsgs().length;
  mod.resumeAcks(); // 模拟重连：重发（budget 2→1）
  ok(userMsgs().length === beforeResume + 1, "重连后重发暂停中的消息");
  ok(userMsgs()[userMsgs().length - 1].client_msg_id === "msg2", "重发仍用同一 client_msg_id");
  advance(15_000); // 重发后 15s 仍无回显 → 再重发（budget 1→0）
  ok(userMsgs().length === beforeResume + 2, "重连重发后仍未确认 → 消耗最后一条重试预算再发");
  advance(15_000); // 再无回显 → 预算耗尽 → fail
  ok(failLog.includes("msg2-fail"), "重连后预算仍被正确耗尽");
  ok(mod.pendingAcksForSession("sessC") === 0, "耗尽后记录清空");

  console.log("--- 场景 4：按文本兜底解除 / 登出清空 ---");
  failLog.length = 0;
  sendAndArm("msg3", "sessD", "legacy", "msg3-fail");
  mod.clearSendAckByText("sessD", "legacy");
  ok(mod.pendingAcksForSession("sessD") === 0, "clearSendAckByText 按旧协议文本兜底解除");
  sendAndArm("msg4", "sessE", "logout-test", "msg4-fail");
  mod.clearAllAcks();
  ok(mod.pendingAcksForSession("sessE") === 0, "clearAllAcks 登出清空全部在途");
  advance(50_000);
  ok(failLog.length === 0, "清理后的挂起计时器不再触发失败");

  console.log("--- 场景 5：重试次数为 0（关闭重试）= 旧行为，超时即失败 ---");
  mod.setSendRetries(0);
  sent.length = 0;
  failLog.length = 0;
  sendAndArm("msg5", "sessF", "no-retry", "msg5-fail");
  advance(15_000);
  ok(failLog.includes("msg5-fail"), "sendRetry=0 时 15s 超时即失败");
  ok(userMsgs().length === 1, "sendRetry=0 时不重发");

  console.log("--- 场景 6：重试次数钳制（上限 5 / 负数→0） ---");
  mod.setSendRetries(99);
  sendAndArm("msg6", "sessG", "cap", "msg6-fail");
  advance(15_000);
  advance(15_000);
  advance(15_000);
  advance(15_000);
  advance(15_000);
  advance(15_000);
  // 上限 5 → 首条 + 最多 5 次重发 = 发 6 条后 fail
  ok(failLog.includes("msg6-fail"), "setSendRetries(99) 视为 5，预算耗尽后失败");
  const capCount = userMsgs().filter((m) => m.client_msg_id === "msg6").length;
  ok(capCount <= 6, `重发次数钳制在上限内（实发 ${capCount} 条，期望 ≤6）`);
  mod.setSendRetries(-3); // → 0
  sent.length = 0;
  failLog.length = 0;
  sendAndArm("msg7", "sessH", "neg", "msg7-fail");
  advance(15_000);
  ok(failLog.includes("msg7-fail"), "setSendRetries(-3)→0 时超时即失败");

  console.log("--- 场景 7：登出后离线重试直接放弃（不泄漏） ---");
  mod.setSocket(null); // 登出 setSocket(null)
  mod.setClosedByUser(true);
  sent.length = 0;
  failLog.length = 0;
  // 登出后即使有残留 ack（理论上 clearAllAcks 已清），计时到点遇 closedByUser 直接放弃
  mod.armSendAck("msg8", "sessI", "post-logout", () => failLog.push("msg8-fail"));
  advance(15_000);
  advance(15_000);
  advance(15_000);
  ok(failLog.length === 0, "登出后离线重试不再触发失败回退（无泄漏回调）");

  console.log(checks.join("\n"));
  console.log(`\nPASS: ${pass}/${checks.length}`);
  process.exit(pass === checks.length ? 0 : 1);
};

void main();
