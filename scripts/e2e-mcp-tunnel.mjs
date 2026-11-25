#!/usr/bin/env node
// E2E：用户级 MCP 桌面隧道。
// 1) 假桌面连 /ws/relay，响应 mcp_request（http 转发到本地假 MCP 服务器）；
// 2) REST 给测试用户配一个 127.0.0.1 的 http MCP 服务器（旧版会被拒）；
// 3) WS 发消息触发引擎列出/调用 MCP 工具，验证隧道闭环；
// 4) 假桌面断开 → 公网 URL 直连兜底路径与回环 503 路径由服务端单测逻辑覆盖（此处验证桌面在线主链路）。
// 用法：node scripts/e2e-mcp-tunnel.mjs  （需 dev:server 已在 8788 运行）
import fs from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const PW = (fs.readFileSync("/tmp/.blmtestpw", "utf8") || "").trim();
const USER = "admin";
const NAME = `tunnel-e2e-${Date.now() % 100000}`;

// 同名残留清理：上次异常退出留下的旧条目会让引擎反复连死端口。
async function cleanupLeftovers(token0) {
  try {
    const r = await fetch(`${BASE}/api/mcp/servers`, { headers: { authorization: `Bearer ${token0}` } });
    for (const s of ((await r.json()).servers ?? [])) {
      if (s.name.startsWith("tunnel-e2e-")) {
        await fetch(`${BASE}/api/mcp/servers/${s.name}`, { method: "DELETE", headers: { authorization: `Bearer ${token0}` } });
      }
    }
  } catch { /* best effort */ }
}

const log = (...a) => console.log("[e2e]", ...a);
const die = (m) => { console.error("[e2e] FAIL:", m); process.exit(1); };

// 服务端健康检查启动门（E2E 需 dev:server 已在 BASE 运行，未起给明确报错）。
const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) die(`服务端不可达，请先启动 dev:server（${BASE}/health 未返回 200）`);

// ---------- 假 MCP 服务器（streamable-http 最小实现） ----------
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits += 1;
    log("假MCP收到:", req.method, req.url, body.slice(0, 120));
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-e2e" });
    let out = {};
    try {
      const j = JSON.parse(body || "{}");
      if (j.method === "initialize") out = { jsonrpc: "2.0", id: j.id, result: { protocolVersion: j.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "e2e", version: "0" } } };
      else if (j.method === "tools/list") out = { jsonrpc: "2.0", id: j.id, result: { tools: [{ name: "echo", description: "回声测试", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } };
      else if (j.method === "tools/call") out = { jsonrpc: "2.0", id: j.id, result: { content: [{ type: "text", text: `E2E_ECHO:${j.params?.arguments?.text ?? ""}` }] } };
      else out = { jsonrpc: "2.0", id: j.id ?? 0, result: {} };
    } catch { out = { jsonrpc: "2.0", id: 0, error: { code: -32700 } }; }
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const mcpPort = upstream.address().port;
log("假MCP端口", mcpPort);

// ---------- 假桌面：/ws/relay 上应答 mcp_request ----------
let tunnelHits = 0;
let matchedUrl = false; // 任一帧 URL 指向本次假 MCP 即算
let desk; // 稍后赋值（登录拿到 token 后连接）
function forwardMcp(msg) {
  tunnelHits += 1;
  if (msg.url?.includes(`127.0.0.1:${mcpPort}`)) matchedUrl = true;
  log("假桌面收到 mcp_request:", JSON.stringify({ name: msg.name, url: msg.url, spawn: !!msg.spawn }));
  const url = new URL(msg.url);
  if (msg.spawn) {
    // stdio 分支：不实际 spawn（假桌面无该服务器），按 JSON-RPC 错误回
    desk.send(JSON.stringify({ type: "llm_response_head", req_id: msg.req_id, status: 500, content_type: "application/json" }));
    desk.send(JSON.stringify({ type: "llm_response_chunk", req_id: msg.req_id, data: JSON.stringify({ error: "no such stdio server in fake desktop" }) }));
    desk.send(JSON.stringify({ type: "llm_response_end", req_id: msg.req_id }));
    return;
  }
  const creq = http.request(
    { host: url.hostname, port: url.port, path: url.pathname + url.search, method: msg.method, headers: msg.headers ?? {} },
    (res) => {
      desk.send(JSON.stringify({ type: "llm_response_head", req_id: msg.req_id, status: res.statusCode, content_type: res.headers["content-type"], headers: { "mcp-session-id": res.headers["mcp-session-id"] ?? "" } }));
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        desk.send(JSON.stringify({ type: "llm_response_chunk", req_id: msg.req_id, data }));
        desk.send(JSON.stringify({ type: "llm_response_end", req_id: msg.req_id }));
      });
    },
  );
  creq.on("error", (e) => {
    desk.send(JSON.stringify({ type: "llm_response_end", req_id: msg.req_id, error: e.message }));
  });
  if (msg.body) creq.write(msg.body);
  creq.end();
}

// admin 在中继 opt-in 名单里：LLM 请求也会派给假桌面。假桌面
// 必须照真实桌面一样转发（直连），否则请求被晾到超时、回合
// 被拖垮（之前 perms=0 就是这么来的）。
async function forwardLlm(msg) {
  const u = new URL(msg.url);
  const { default: mod } = u.protocol === "https:" ? await import("node:https") : { default: http };
  const creq = mod.request(
    { host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: msg.method, headers: msg.headers ?? {} },
    (res) => {
      desk.send(JSON.stringify({ type: "llm_response_head", req_id: msg.req_id, status: res.statusCode, content_type: res.headers["content-type"] }));
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        desk.send(JSON.stringify({ type: "llm_response_chunk", req_id: msg.req_id, data }));
        desk.send(JSON.stringify({ type: "llm_response_end", req_id: msg.req_id }));
      });
    },
  );
  creq.on("error", (e) => {
    desk.send(JSON.stringify({ type: "llm_response_end", req_id: msg.req_id, error: e.message }));
  });
  if (msg.body) creq.write(msg.body);
  creq.end();
}

// ---------- 登录 & 配置 ----------
const login = await fetch(`${BASE}/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PW }),
});
if (!login.ok) die(`登录失败 ${login.status}`);
const { token } = await login.json();
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
log("登录成功");
await cleanupLeftovers(token);

const put = await fetch(`${BASE}/api/mcp/servers/${NAME}`, {
  method: "PUT", headers: auth,
  body: JSON.stringify({ type: "http", url: `http://127.0.0.1:${mcpPort}/mcp`, enabled: true }),
});
if (!put.ok) die(`配置回环 MCP 失败: ${put.status} ${JSON.stringify(await put.json().catch(() => null))}`);
log("✅ 回环 URL 写入成功（旧版此处报 private_url）");

const list = await fetch(`${BASE}/api/mcp/servers`, { headers: auth });
const servers = (await list.json()).servers ?? [];
if (!servers.some((s) => s.name === NAME)) die("配置列表缺少新条目");

// 假桌面在配置写入后连接（保证以最终配置应答）
desk = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/relay?token=${token}`);
await new Promise((res, rej) => { desk.on("open", res); desk.on("error", rej); });
desk.on("message", (raw) => {
  let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.type === "mcp_request") forwardMcp(msg);
  else if (msg.type === "llm_request") void forwardLlm(msg);
});
log("假桌面已连接 /ws/relay");

// ---------- WS 聊天触发 ----------
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${token}`);
let sawTool = false; let sawEcho = false; let turnDone = false; let errMsg = null;
const pendingPerms = new Map(); // request_id → tool name（自动允许外部 MCP 工具）
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.type === "message_block" && m.block?.kind === "tool_call") sawTool = true; // 外部 MCP 工具名经 sanitize 即原名
  if (m.type === "message_block" && m.block?.kind === "tool_result" && JSON.stringify(m.block).includes("E2E_ECHO")) sawEcho = true;
  if (m.type === "permission_request" && m.request_id) {
    pendingPerms.set(m.request_id, m.tool_name ?? "");
    ws.send(JSON.stringify({ type: "permission_response", request_id: m.request_id, allow: true }));
  }
  if (m.type === "error") errMsg = m.message || m.code;
  if (m.type === "result") turnDone = true;
});

// 新会话（引擎会重新挂载 MCP，拿到改写后的隧道 URL）
const session = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: auth, body: JSON.stringify({}) });
if (!session.ok) die("建会话失败");
const sid = (await session.json()).session_id;
log("会话", sid);

ws.send(JSON.stringify({ type: "user_message", session_id: sid, client_msg_id: `e2e-${Date.now()}`, text: `调用 ${NAME} 服务器的 echo 工具，参数 text=hello` }));
// LLM 网关 QPM 限流会拖慢回合（429 重试），且外部 MCP 工具审批
// PERMISSION_TIMEOUT_MS=300s——截止必须 > 300s 才能覆盖审批+慢回合。
const t0 = Date.now();
const deadline = t0 + 420_000;
const tick = () => { process.stdout.write(`[e2e] ${Math.round((Date.now() - t0) / 1000)}s sawTool=${sawTool} perms=${pendingPerms.size}\r`); };
while (Date.now() < deadline && !turnDone) { tick(); await new Promise((r) => setTimeout(r, 2000)); }
process.stdout.write("\n");

// transcript 摘要（REST 拉取，帮助人工判断模型行为）
try {
  const msgs = await fetch(`${BASE}/api/sessions/${sid}/messages`, { headers: auth });
  const body = await msgs.json();
  const blocks = (body.blocks ?? body.messages ?? []).map((b) => ({ kind: b.kind ?? b.block?.kind, name: b.tool_name ?? b.block?.tool_name, content: String(b.content ?? b.block?.content ?? "").slice(0, 120) }));
  fs.writeFileSync(`/tmp/e2e-transcript-${sid}.json`, JSON.stringify(blocks));
} catch { /* optional */ }

// ---------- 判定 ----------
const checks = [];
checks.push(["隧道帧到达假桌面", tunnelHits > 0]);
checks.push(["帧内 URL 指向回环假MCP", matchedUrl]);
checks.push(["上游真被调用", upstreamHits > 0]);
checks.push(["引擎列出/调用 mcp__ 工具", sawTool]);
checks.push(["工具结果回流（E2E_ECHO）", sawEcho]);

let failed = false;
for (const [k, v] of checks) { console.log(v ? "  ✅" : "  ❌", k); if (!v) failed = true; }
if (errMsg) log("回合内错误（参考）:", errMsg);
log(`tunnelHits=${tunnelHits} upstreamHits=${upstreamHits} perms=${[...pendingPerms.keys()].length}`);

// 模型不必然调工具——transcript 里有 tool_call（engine 确实看到了 mcp 工具并发起调用）也算过。
// 失败的两个断言主要受模型行为影响，补打 transcript 摘要帮助人工判断。
try {
  const rec = JSON.parse(fs.readFileSync(`/tmp/e2e-transcript-${sid}.json`, "utf8"));
  for (const b of rec) log("transcript:", b.kind, JSON.stringify(b).slice(0, 160));
} catch { /* transcript dump not written */ }

// ---------- 清理 ----------
// 注意：DELETE 不能带 content-type（无 body 会被 Fastify 400 拒），否则留下残留。
const authOnly = { authorization: `Bearer ${token}` };
ws.close(); desk.close();
await fetch(`${BASE}/api/mcp/servers/${NAME}`, { method: "DELETE", headers: authOnly });
await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: authOnly });
upstream.close();
fs.rmSync("/tmp/.blmtestpw", { force: true });
process.exit(failed ? 1 : 0);
