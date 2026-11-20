// 假 stdio MCP 服务器（newline-delimited JSON-RPC，供 test-stdio-bridge 用）
// initialize/tools-list 正常回包；method=hang 不回包（测进程死亡/超时）。
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j.method === "hang") return; // 故意不回
  let result;
  if (j.method === "initialize") result = { serverInfo: { name: "fake-stdio", version: "0" } };
  else if (j.method === "tools/list") result = { tools: [{ name: "ping", description: "测试" }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }) + "\n");
});
