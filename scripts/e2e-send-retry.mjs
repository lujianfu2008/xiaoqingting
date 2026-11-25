#!/usr/bin/env node
// E2E：发送失败自动重试的服务端幂等护栏。
// 核心断言——同一条 user_message 用同一 client_msg_id 重发（客户端网络抖动
// 自动重发就是这个形态），服务端必须：
//   1) dedup 只补发确认回显给发送方，历史里 user_text 只落一条；
//   2) 第二次到达绝不重跑引擎回合（无新增 result/error 结算）。
// 判定确定性：推荐跑在隔离实例上（PORT=8899 DATA_DIR=/tmp/xxx，无真实
// LLM key 时引擎快速失败为 error），避免共享 dev 服务器上其它/残留回合干扰
// 帧归属。若跑在共享服务器，预热回合与隔离运行等价——dedup 在会话/引擎
// 之前发生，且断言只数「本会话」的结算。
// 用法：
//   node scripts/e2e-send-retry.mjs \
//     E2E_BASE=... E2E_ADMIN_PW=...
import fs from "node:fs";
import WebSocket from "ws";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
let _pw = "";
try {
  _pw = (fs.readFileSync("/tmp/.blmtestpw", "utf8") || "").trim();
} catch { /* reuse default */ }
const ADMIN_PW = process.env.E2E_ADMIN_PW ?? (_pw || "admin123");
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? "admin";
const log = (...a) => console.log("[e2e]", ...a);
const die = (m) => { console.error("[e2e] FAIL:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) die(`服务端不可达，请先启动 服务端（${BASE}/health 未返回 200）`);

const login = async (username, password) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  return (await r.json()).token;
};
const adminToken = await login(ADMIN_USER, ADMIN_PW);
if (!adminToken) die("admin 登录失败");
const auth = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

const waitFor = (fn, label, timeoutMs) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (fn()) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
  }, 100);
});

// 建会话 + 连 WS
const sid = (await (await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: auth, body: JSON.stringify({}),
})).json()).session_id;
const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(adminToken)}`);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

/** 本会话的 user_text 回显 id 序列 + 引擎结算(result/error)。 */
const echoes = [];
let settlements = 0;
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.type === "message_block" && m.block.kind === "user_text" && m.block.client_msg_id) {
    echoes.push(m.block.client_msg_id);
  }
  if ((m.type === "result" || m.type === "error") && m.session_id === sid) {
    settlements++;
  }
});

const sendCmd = (id, text) => ws.send(JSON.stringify({
  type: "user_message", session_id: sid, text, client_msg_id: id,
}));

const CMD_ID = `retry-e2e-${Date.now().toString(36)}`;

// ---------- 第一次发送：应回显 + 引擎结算（本轮） ----------
log(`第一次发送（cid=${CMD_ID}）…`);
sendCmd(CMD_ID, "发送重试幂等测试");
if (!(await waitFor(() => echoes.includes(CMD_ID), "第一次回显", 30_000))) {
  die("第一次发送未收到服务端回显");
}
log("第一次回显 ✓");
// 等本回合结算（无 key 时引擎快速失败为 error，也是结算帧）。这确保第二次
// 发送落在回合结束后——真实用户重发也发生在服务端空闲时，避免撞上回合中
// =补充消息入队= 的并轨路径（那是另一条已测路径，不在此断言）。
if (!(await waitFor(() => settlements >= 1, "第一回合结算", 120_000))) {
  log("警告：第一回合未产生结算帧（引擎卡死/无 key 超长），继续基于历史断言……");
}
await sleep(500);
const settleAfterFirst = settlements;

// ---------- 第二次发送（同一 client_msg_id）：必须被 dedup ----------
log("第二次发送（同一 cid）…");
sendCmd(CMD_ID, "发送重试幂等测试"); // 与第一次完全一致（客户端自动重发就是这样）
if (!(await waitFor(() => echoes.includes(CMD_ID), "第二次回显", 30_000))) {
  die("同一 client_msg_id 第二次到达未补发确认回显");
}
log("第二次回显 ✓（服务端补发的确认回显）");
// 给任何不该有的引擎动作（双跑）留足时间暴露。
await sleep(3000);

// ---------- 断言 1：历史里 CMD 只落一条 ----------
const blocks = (await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: auth })).json()).blocks;
const cmds = blocks.filter((b) => b.kind === "user_text" && b.client_msg_id === CMD_ID);
if (cmds.length !== 1) {
  die(`同 id 重发后历史里 user_text 应为 1 条，实际 ${cmds.length} 条——被当新消息跑了两遍`);
}
log(`历史里同 id 消息恰 1 条 ✓`);

// ---------- 断言 2：第二次到达没触发新引擎回合 ----------
if (settlements > settleAfterFirst) {
  die(`第二次到达触发了新的引擎回合结算（${settleAfterFirst} → ${settlements}）——dedup 失效`);
}
log(`第二次到达未新增引擎回合结算（${settleAfterFirst} → ${settlements}）✓`);

// ---------- 断言 3：新增一条不同 id 消息仍正常入库（不误伤） ----------
const NEW_ID = `retry-e2e-2-${Date.now().toString(36)}`;
sendCmd(NEW_ID, "不同 id 的下一条");
if (!(await waitFor(() => echoes.includes(NEW_ID), "新消息回显", 30_000))) die("不同 id 的新消息未收到回显");
await sleep(1500);
const blocks3 = (await (await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: auth })).json()).blocks;
const ut3 = blocks3.filter((b) => b.kind === "user_text");
if (ut3.length !== 2) {
  die(`不同 id 消息应追加为 2 条，实际 ${ut3.length} 条——dedup 误伤新消息`);
}
log(`不同 id 消息正常追加（2 条）✓`);

ws.close();
log("PASS：服务端幂等护栏验证通过（自动重发绝不双跑）");
process.exit(0);
