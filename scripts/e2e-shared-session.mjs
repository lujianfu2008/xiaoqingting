#!/usr/bin/env node
// E2E：共享会话实时可见（服务端差分广播 + 取消/删除/重命名同步）。
// 1) 确保第二用户存在并已审批（首次注册，之后幂等复用——避开注册限流）；
// 2) 双方各自建一个会话；admin 把会话共享给第二用户；
// 3) 断言第二用户在线 WS 即时收到 session_created（无需重登）；
// 4) admin 取消共享 → 第二用户在线收到 session_unshared；
// 5) 重新共享（全员）→ again session_created → 重命名 → 收最新标题 → 删除 → session_unshared。
// 纯 REST+WS，无引擎/LLM 参与，判定完全确定性。可复用已存在用户：
// E2E_B_USER=xxx E2E_B_PASS=yyy 覆盖（避开 10 注册/小时/IP 限流）。
// 用法：node scripts/e2e-shared-session.mjs  （需 dev:server 已在 8788 运行）
import fs from "node:fs";
import WebSocket from "ws";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const WS_BASE = BASE.replace(/^http/, "ws");
const ADMIN_PW = (fs.readFileSync("/tmp/.blmtestpw", "utf8") || "").trim() || "admin123";
// 固定第二用户：跨运行幂等复用（注册预算 10/小时/IP 只在首次创建时消耗一次）。
// E2E_B_USER/E2E_B_PASS 可覆盖（比如复用已存在的测试用户，避开注册限流）。
const B_USER = process.env.E2E_B_USER ?? "share-e2e-bob";
const B_PASS = process.env.E2E_B_PASS ?? "share-e2e-pass";
const log = (...a) => console.log("[e2e]", ...a);
const die = (m) => { console.error("[e2e] FAIL:", m); process.exit(1); };

// 服务端健康检查启动门（E2E 需 dev:server 已在 BASE 运行，未起给明确报错）。
const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) die(`服务端不可达，请先启动 dev:server（${BASE}/health 未返回 200）`);

const login = async (username, password) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  return (await r.json()).token;
};

async function waitFor(fn, label, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) {
      die(`等待超时: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

const ADMIN_USER = process.env.E2E_ADMIN_USER ?? "admin";
const adminToken = await login(ADMIN_USER, ADMIN_PW);
const adminAuth = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
log("admin 登录成功");

// ---------- 确保第二用户存在并已审批（幂等：已有则直接登录） ----------
let bToken = await login(B_USER, B_PASS);
if (!bToken) {
  // 可能：① 尚未注册（首次运行）；② 已注册但审批过（异常退出留下的 pending）。
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: B_USER, password: B_PASS, employee_id: "E2E-BOB" }),
  });
  if (reg.status !== 201) {
    // 409 = 用户名已被占用：存在 pending 残留或并发环境另一进程已注册。
    // 固定用户名不可能"被真实用户抢注"——审批/复用即可，不 die。
    if (reg.status !== 409) die(`注册失败 ${reg.status}: ${await reg.text()}`);
    log("用户已存在（前次残留或并发注册），走审批复用…");
  } else {
    log("第二用户首次注册（待审批）");
  }
  // 待审核账号无法登录，admin 审批通过（已通过时 decide 返回 400，无害）。
  const dec = await fetch(`${BASE}/api/review/users/${B_USER}/decide`, {
    method: "POST", headers: adminAuth, body: JSON.stringify({ approve: true }),
  });
  if (dec.status === 400) log("复核：用户已是 approved（无常量残留）");
  else if (!dec.ok) die(`审批失败 ${dec.status}: ${await dec.text()}`);
  bToken = await login(B_USER, B_PASS);
  if (!bToken) die("审批后仍无法登录");
}
log(`第二用户 ${B_USER} 登录成功（已通过审批）`);

// ---------- 双方连接 WS ----------
const msgLog = { created: [], unshared: [] };
const openWs = (token) => {
  const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "session_created") msgLog.created.push(m.session);
    if (m.type === "session_unshared") msgLog.unshared.push(m.session_id);
  });
  return ws;
};
const wsA = openWs(adminToken);
const wsB = openWs(bToken);
await Promise.all([
  new Promise((res, rej) => { wsA.on("open", res); wsA.on("error", rej); }),
  new Promise((res, rej) => { wsB.on("open", res); wsB.on("error", rej); }),
]);
log("双方 WS 已连接");

// ---------- 建会话 ----------
const mkSess = async (token) => {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) die(`建会话失败 ${r.status}`);
  return (await r.json()).session_id;
};
const ownerSid = await mkSess(adminToken);
await mkSess(bToken);
log("双方各建会话，主人会话", ownerSid);

const checks = [];

// ---------- 场景 1：共享 → B 即时收到 session_created ----------
msgLog.created.length = 0;
const share1 = await fetch(`${BASE}/api/sessions/${ownerSid}/share`, {
  method: "POST", headers: adminAuth,
  body: JSON.stringify({ shared: true, shared_with: [B_USER] }),
});
if (!share1.ok) die(`共享失败 ${share1.status}: ${await share1.text()}`);
await waitFor(() => msgLog.created.some((s) => s.session_id === ownerSid), "B 收到 session_created");
const gotCreated = msgLog.created.find((s) => s.session_id === ownerSid);
checks.push(["共享后 B 即时收到 session_created（无需重登）", !!gotCreated]);
checks.push(["session_created 带 owner", gotCreated?.owner === ADMIN_USER]);
checks.push(["B 的 /api/shared 现在能看到该会话", (await (await fetch(`${BASE}/api/shared`, { headers: { authorization: `Bearer ${bToken}` } })).json()).some((s) => s.session_id === ownerSid)]);

// ---------- 场景 2：取消共享 → B 即时收到 session_unshared ----------
await new Promise((r) => setTimeout(r, 300)); // 等上面断言缓存刷新
msgLog.unshared.length = 0;
const unshare1 = await fetch(`${BASE}/api/sessions/${ownerSid}/share`, {
  method: "POST", headers: adminAuth,
  body: JSON.stringify({ shared: false }),
});
if (!unshare1.ok) die(`取消共享失败 ${unshare1.status}: ${await unshare1.text()}`);
await waitFor(() => msgLog.unshared.includes(ownerSid), "B 收到 session_unshared");
checks.push(["取消共享后 B 即时收到 session_unshared", msgLog.unshared.includes(ownerSid)]);
checks.push(["B 的 /api/shared 已不含该会话", !(await (await fetch(`${BASE}/api/shared`, { headers: { authorization: `Bearer ${bToken}` } })).json()).some((s) => s.session_id === ownerSid)]);

// ---------- 场景 3：重新共享（全员）→ B 收到；删除 → B 收到 unshared ----------
msgLog.created.length = 0;
msgLog.unshared.length = 0;
const share2 = await fetch(`${BASE}/api/sessions/${ownerSid}/share`, {
  method: "POST", headers: adminAuth,
  body: JSON.stringify({ shared: true }),
});
if (!share2.ok) die(`重新共享失败 ${share2.status}`);
await waitFor(() => msgLog.created.some((s) => s.session_id === ownerSid), "B 收到重新共享 session_created");
checks.push(["重新共享（全员）后 B 再次收到 session_created", msgLog.created.some((s) => s.session_id === ownerSid)]);

// ---------- 场景 3b：重命名共享会话 → B 在线收到最新标题（session_created 更新） ----------
const NEW_TITLE = `共享标题-${Date.now() % 100000}`;
const rename = await fetch(`${BASE}/api/sessions/${ownerSid}/title`, {
  method: "POST", headers: adminAuth, body: JSON.stringify({ title: NEW_TITLE }),
});
if (!rename.ok) die(`重命名失败 ${rename.status}: ${await rename.text()}`);
await waitFor(
  () => msgLog.created.some((s) => s.session_id === ownerSid && s.title === NEW_TITLE),
  "B 收到重命名后的最新标题",
);
checks.push(["重命名共享会话后 B 即时收到最新标题", true]);

// DELETE 带 content-type 头会让 Fastify 400 拒（其 e2e 脚本同款坑）：不带 body。
const del = await fetch(`${BASE}/api/sessions/${ownerSid}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${adminToken}` },
});
if (!del.ok) die(`删会话失败 ${del.status}: ${await del.text()}`);
await waitFor(() => msgLog.unshared.includes(ownerSid), "B 收到删除后的 session_unshared");
checks.push(["主人删除共享会话后 B 收到 session_unshared 摘除", msgLog.unshared.includes(ownerSid)]);
checks.push(["B 的 /api/shared 已不含已删会话", !(await (await fetch(`${BASE}/api/shared`, { headers: { authorization: `Bearer ${bToken}` } })).json()).some((s) => s.session_id === ownerSid)]);

// ---------- 判定 ----------
let failed = false;
for (const [k, v] of checks) { console.log(v ? "  ✅" : "  ❌", k); if (!v) failed = true; }
if (failed) die("存在失败断言");

// ---------- 清理 ----------
wsA.close(); wsB.close();
process.exit(0);
