#!/usr/bin/env node
// stdioBridge node 级验证（模块不 import electron，可直接实例化）：
// spawn → newline-delimited JSON-RPC → 按 id 关联回包 → 进程复用 →
// 进程死亡失败回包 → 超时收割。
// 用法：node --input-type=module -e "..." 不便 import TS，改由 tsx 跑：
//   npx tsx scripts/e2e-stdio-bridge.mts.ts 不好 —— 这里用 register 方式。
// 实际执行：node scripts/test-stdio-bridge.mjs （内部用 tsx 的 api 装 TS 模块）
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
process.chdir(path.join(here, "..", "packages", "desktop"));
// tsx register：让 require 能加载 TS 源码
// tsx 进程内运行时无需手动 register（tsx --import 已装钩子）

const { handleStdioMcpRequest, shutdownStdioBridge } = await import(
  pathToFileURL(path.join(here, "..", "packages", "desktop", "src", "main", "mcp", "stdioBridge.ts")).href
);

const log = (...a) => console.log("[t]", ...a);
let failed = false;
const check = (ok, name) => {
  console.log(ok ? "  ✅" : "  ❌", name);
  if (!ok) failed = true;
};

function call(req) {
  return new Promise((resolve) => {
    const parts = {};
    const handle = handleStdioMcpRequest(req, {
      onHead: (status, ct) => (parts.status = status),
      onData: (d) => (parts.data = (parts.data ?? "") + d),
      onEnd: (err) => resolve({ ...parts, err }),
    });
    req._handle = handle;
  });
}

const spawnDef = {
  command: process.execPath,
  args: [path.join(here, "fixtures", "fake-stdio-mcp.mjs")],
};

// 1. 基本调用：initialize 回包按 id 关联
const r1 = await call({
  req_id: "a1", name: "t1", spawn: spawnDef,
  body: JSON.stringify({ jsonrpc: "2.0", id: "i1", method: "initialize", params: {} }),
});
check(r1.status === 200 && JSON.parse(r1.data).id === "i1", "initialize 按 id 回包");
check(JSON.parse(r1.data).result.serverInfo.name === "fake-stdio", "回包内容正确");

// 2. 同名复用同一进程
const r2 = await call({
  req_id: "a2", name: "t1", spawn: spawnDef,
  body: JSON.stringify({ jsonrpc: "2.0", id: "i2", method: "tools/list" }),
});
check(r2.status === 200 && JSON.parse(r2.data).id === "i2", "同名复用进程第二问");

// 3. notification（无 id）：202 即回
const r3 = await call({
  req_id: "a3", name: "t1", spawn: spawnDef,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
check(r3.status === 202, "notification 回 202");

// 4. spawn 失败（不存在的命令）：500
const r4 = await call({
  req_id: "a4", name: "t-bad", spawn: { command: "/nonexistent-cmd-e2e" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "i4", method: "x" }),
});
// spawn ENOENT：node spawn 同步抛错误（shell:false linux）→ getProc 返回 null
check(r4.status === 500 || r4.status === 502, `spawn 失败回错误（${r4.status}）`);

// 5. 进程死亡：kill 后在途请求失败（502 非 200）
const deadP = call({
  req_id: "a5", name: "t-dead", spawn: spawnDef,
  body: JSON.stringify({ jsonrpc: "2.0", id: "i5", method: "hang" }), // fake 不回 → 等待
});
await new Promise((r) => setTimeout(r, 400)); // 等 spawn 完成
// 杀进程：通过第二次请求拿到 handle 不行——直接给 fake 发 kill：调用一个 killme 工具让 fake 自杀
const r5 = await Promise.race([deadP, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
// fake-stdio hang 不回包，进程活着；用 shutdown 杀它 → waiter 收到 null → 502
shutdownStdioBridge();
const r5b = deadP instanceof Promise ? await deadP : r5;
check(r5b.status === 502, `进程死亡回 502（实际 ${r5b.status}）`);

setTimeout(() => process.exit(failed ? 1 : 0), 100);

// （附加）进程死亡后同名重生：t-dead 被 shutdown 杀了，再发一问应重新 spawn
const r6 = await call({
  req_id: "a6", name: "t-dead", spawn: spawnDef,
  body: JSON.stringify({ jsonrpc: "2.0", id: "i6", method: "initialize", params: {} }),
});
check(r6.status === 200 && JSON.parse(r6.data).id === "i6", "死亡后同名重生");
shutdownStdioBridge();
