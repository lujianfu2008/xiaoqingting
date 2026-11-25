#!/usr/bin/env node
// E2E：用户管理三处删除（用户账号级联 / 操作日志单条+清空 / 显示诊断单条）。
// 需要 dev:server 已在 BASE 运行（tsx watch 自动加载新路由）。
// 用法：node scripts/e2e-admin-delete.mjs
// 说明：用独立测试用户（时间戳后缀，幂等重跑不撞库里真实账号）；
// 共享 dev 服务器可能有真实用户在线，本测试只动自己创建的测试账号。
import fs from "node:fs";
import crypto from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const ADMIN_PW = (fs.readFileSync("/tmp/.blmtestpw", "utf8") || "").trim() || "admin123";
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? "admin";
const T = Date.now().toString(36);
const VICTIM = `del-e2e-${T}`;
const VICTIM_PW = "del-e2e-pass";

const log = (...a) => console.log("[e2e]", ...a);
const die = (m) => { console.error("[e2e] FAIL:", m); process.exit(1); };

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) die(`服务端不可达，请先启动 dev:server（${BASE}/health 未返回 200）`);

const call = async (path, method, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: token ? `Bearer ${token}` : "",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, json };
};

// 管理员登录。
let adminToken = null;
{
  const r = await call("/auth/login", "POST", null, { username: ADMIN_USER, password: ADMIN_PW });
  if (r.status !== 200) die(`管理员登录失败: ${r.status}`);
  adminToken = r.json.token;
}

// ---------- 1) 注册测试用户 + 通过审批 ----------
const reg = await call("/auth/register", "POST", null, {
  username: VICTIM, password: VICTIM_PW, employee_id: `E2E-${T}`,
});
log("注册状态", reg.status);
// 若已存在（注册限流/复用），直接登录。
let victimAuth = null;
{
  const l = await call("/auth/login", "POST", null, { username: VICTIM, password: VICTIM_PW });
  if (l.status === 200) victimAuth = l.json.token;
}
if (!victimAuth) {
  // 找待审核用户 → 管理员通过。
  const pending = await call("/api/review/users", "GET", adminToken);
  const hit = (pending.json?.users ?? []).find((u) => u.username === VICTIM);
  log("待审核列表命中", hit ? "是" : "否", "状态", pending.status);
  if (hit) {
    const dec = await call(`/api/review/users/${encodeURIComponent(VICTIM)}/decide`, "POST", adminToken, { approve: true });
    log("审批", dec.status);
  }
  const l2 = await call("/auth/login", "POST", null, { username: VICTIM, password: VICTIM_PW });
  log("审批后登录", l2.status);
  if (l2.status === 200) victimAuth = l2.json.token;
}
if (!victimAuth) die(`测试用户 ${VICTIM} 登录失败`);

// 审核通过后接受登录。管理员读取用户列表确认在列。
const users = await call("/api/admin/users", "GET", adminToken);
if (!(users.json?.users ?? []).some((u) => u.username === VICTIM)) {
  die("管理页用户列表里找不到测试账号");
}

// ---------- 2) 给测试账号造点数据（会话） ----------
const mkSess = await call("/api/sessions", "POST", victimAuth, { agent_id: "assistant", title: "delete-e2e" });
if (mkSess.status !== 200 && mkSess.status !== 201) die(`创建会话失败: ${mkSess.status} ${JSON.stringify(mkSess.json)}`);
log(`测试账号 ${VICTIM} 会话已建（${mkSess.json.session_id}）`);
const victimSid = mkSess.json.session_id;

// ---------- 3) 用户删除：先验证挡板（给 victim 建一个 enabled 定时任务） ----------
const sched = await call("/api/schedules", "POST", victimAuth, {
  name: "e2e 定时",
  prompt: "跑一下",
  agent_id: "assistant",
  time: { kind: "daily", time: "11:00" },
  enabled: true,
});
if (sched.status !== 200 && sched.status !== 201) die(`建定时任务失败: ${sched.status} ${JSON.stringify(sched.json)}`);
log("已建 enabled 定时任务");

const blockedDel = await call(`/api/admin/users/${encodeURIComponent(VICTIM)}`, "DELETE", adminToken);
if (blockedDel.status !== 409) die(`有启用定时任务时删除应 409，实际 ${blockedDel.status}`);
log("挡板生效：有启用定时任务 → 409");

// 停用定时任务后再删。
const schedId = sched.json.schedule_id;
const disable = await call(`/api/schedules/${schedId}/enabled`, "POST", victimAuth, { enabled: false });
if (disable.status !== 200 && disable.status !== 204) die(`停用定时任务失败: ${disable.status}`);
log("已停用定时任务");

// ---------- 4) 删除用户 → 应 200；账号不可登录；列表无此人 ----------
const delOk = await call(`/api/admin/users/${encodeURIComponent(VICTIM)}`, "DELETE", adminToken);
if (delOk.status !== 200) die(`删除用户应 200，实际 ${delOk.status}: ${JSON.stringify(delOk.json)}`);
log("用户删除成功");

const relogin = await call("/auth/login", "POST", null, { username: VICTIM, password: VICTIM_PW });
if (relogin.status === 200) die("删除后账号仍能登录！");
const users2 = await call("/api/admin/users", "GET", adminToken);
if ((users2.json?.users ?? []).some((u) => u.username === VICTIM)) die("删除后用户仍在列表！");
log("账号已从登录与列表移除");

// 会话数据已删（GET /api/sessions 是 owner 权限；staff 删后无从查——用管理员视角检查不了会话。
// 会话删除由级联单测覆盖，这里只验证可登录性 + 列表移除 + 审计留痕。）

// 审计留痕：应有一条 user.delete。
const audit = await call("/api/admin/audit?limit=50", "GET", adminToken);
const delAudit = (audit.json?.entries ?? []).find(
  (e) => e.action === "user.delete" && e.target === VICTIM,
);
if (!delAudit) die("审计日志里应留有 user.delete 记录");

// ---------- 5) 操作日志：单条删除 + 清空 ----------
// 取一条审计（操作者是 admin 自己的也行），单条删除。
const entries = audit.json.entries;
if (!entries.length) die("审计为空，无法测删除");
const victimLog = entries.find((e) => e.action === "user.delete") ?? entries[0];
const delEntry = await call("/api/admin/audit/delete", "POST", adminToken, {
  ts: victimLog.ts, actor: victimLog.actor, action: victimLog.action,
});
if (delEntry.status !== 200) die(`审计单条删除应 200，实际 ${delEntry.status}`);
const audit2 = await call("/api/admin/audit?limit=500", "GET", adminToken);
const stillThere = (audit2.json?.entries ?? []).some(
  (e) => e.ts === victimLog.ts && e.actor === victimLog.actor && e.action === victimLog.action,
);
if (stillThere) die("审计单条删除后仍在列表");
log("审计单条删除 OK");

// 清空（仅显式允许时）：共享 dev 服务器可能有真实审计记录，不能顺手清光。
// 本地隔离服务器跑 E2E_ALLOW_CLEAR=1 才实际执行。
if (process.env.E2E_ALLOW_CLEAR === "1") {
  const cleared = await call("/api/admin/audit/clear", "POST", adminToken);
  if (cleared.status !== 200) die(`审计清空应 200，实际 ${cleared.status}`);
  const audit3 = await call("/api/admin/audit?limit=500", "GET", adminToken);
  const afterClear = audit3.json?.entries ?? [];
  if (afterClear.length > 1) die(`清空后审计应为空或仅剩清空凭据，实际 ${afterClear.length} 条`);
  log("审计清空 OK（剩余", afterClear.length, "条）");
} else {
  log("跳过审计清空（E2E_ALLOW_CLEAR=1 才执行；共享服务器不清真实审计）");
}

// ---------- 6) 显示诊断：单条删除路由 ----------
// 管理端诊断列表需要真实回传的条目才有；这里验证删除路由对不存在的 id 返回 404，
// 以及鉴权（非管理员 403）——证明路由已挂。
const diagDel = await call("/api/admin/diag/nonexistent-id", "DELETE", adminToken);
if (diagDel.status !== 404) die(`诊断删除应 404，实际 ${diagDel.status}`);
const diagNoAuth = await call("/api/admin/diag/nonexistent-id", "DELETE", victimAuth);
if (diagNoAuth.status !== 403 && diagNoAuth.status !== 401) die(`诊断删除非管理员应 403/401，实际 ${diagNoAuth.status}`);
log("显示诊断删除路由 OK（404 未命中 + 非管理员拒绝）");

console.log("\n[E2E] ✅ 全部通过");
process.exit(0);
