import type { McpSpawn } from "@blm/protocol";

// 用户级 stdio MCP 服务器桥（main 进程）：服务端把 mcp_request（带
// spawn 参数）经 /ws/relay 转来，这里 spawn 本机子进程、把请求体
// （JSON-RPC，newline-delimited）写进 stdin，按行读 stdout，把每行
// JSON 作为响应体经 llm_response 帧族回传。同名服务器复用同一进程
// （MCP 服务器有会话状态），崩溃后下一条请求重生。
//
// 仅支持「客户端 → 服务器」方向的调用：无 id 的 notification 回 202 空
// 体；服务端主动请求（GET 长轮询/服务端→客户端 RPC）不支持——大多数
// 工具型 MCP 服务器不用。子进程 env 取最小白名单 + 配置 env，不透传
// 桌面主进程的完整环境。

const IDLE_KILL_MS = 5 * 60_000; // 无请求 5 分钟收割进程
const MAX_PROCS = 8; // LRU 上限（防 spawn 滥用）

interface McpProc {
  child: import("node:child_process").ChildProcess;
  /** 每请求 settle（JSON-RPC id → 回调；null = 进程已死）。 */
  waiters: Map<string, (line: string | null) => void>;
  /** 单请求超时。 */
  timers: Map<string, NodeJS.Timeout>;
  buffer: string;
  idleTimer?: NodeJS.Timeout;
  alive: boolean;
}

const procs = new Map<string, McpProc>();

export interface McpTunnelRequest {
  req_id: string;
  name: string;
  body?: string;
  spawn: McpSpawn;
}

export interface McpTunnelCallbacks {
  onHead(status: number, contentType?: string): void;
  onData(text: string): void;
  onEnd(err?: string): void;
}

function minimalEnv(): Record<string, string> {
  // 子进程最少需要 PATH 找可执行文件、HOME/TMPDIR 兜底；其余全由
  // 配置 env 显式给出。不透传桌面主进程环境（可能含代理凭证等）。
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT", "COMSPEC"]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function killIdle(name: string): void {
  const p = procs.get(name);
  if (!p) return;
  p.alive = false;
  procs.delete(name);
  try {
    p.idleTimer && clearTimeout(p.idleTimer);
    p.child.kill();
  } catch {
    // already dead
  }
  for (const t of p.timers.values()) clearTimeout(t);
  p.timers.clear();
  for (const settle of p.waiters.values()) settle(null);
  p.waiters.clear();
}

function getProc(name: string, spawn: McpSpawn): McpProc | null {
  const cur = procs.get(name);
  if (cur?.alive) {
    clearTimeout(cur.idleTimer);
    cur.idleTimer = setTimeout(() => killIdle(name), IDLE_KILL_MS);
    return cur;
  }
  // LRU 收割：超上限先杀最旧（Map 迭代序即插入序）。
  while (procs.size >= MAX_PROCS) {
    const oldest = procs.keys().next().value;
    if (oldest === undefined) break;
    killIdle(oldest);
  }
  // Windows 下 npx/node 等需 PATH 解析的 .cmd shim 可能 ENOENT，
  // 兜底走 shell（注意：spawn 参数含空格路径时有理论风险，调用
  // 侧保证 args 为数组、不经 shell 拼接）。
  const isWin = process.platform === "win32";
  const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
  let child;
  try {
    child = nodeSpawn(spawn.command, spawn.args ?? [], {
      shell: isWin,
      env: { ...minimalEnv(), ...(spawn.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(`[mcp-stdio] spawn 失败 (${name}): ${(err as Error).message}`);
    return null;
  }
  if (!child.stdin || !child.stdout) return null;

  const proc: McpProc = {
    child,
    waiters: new Map(),
    timers: new Map(),
    buffer: "",
    idleTimer: setTimeout(() => killIdle(name), IDLE_KILL_MS),
    alive: true,
  };
  procs.set(name, proc);

  const decoder = new (require("node:string_decoder") as typeof import("node:string_decoder")).StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => {
    proc.buffer += decoder.write(chunk);
    for (;;) {
      const nl = proc.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = proc.buffer.slice(0, nl).trim();
      proc.buffer = proc.buffer.slice(nl + 1);
      if (!line) continue;
      settleLine(proc, line);
    }
  });
  child.stdout.on("end", () => {
    // 进程退出且输出流结束：所有在途请求立即失败。
    procFail(proc, "MCP 服务器进程已退出");
  });
  child.on("error", (err: Error) => {
    console.error(`[mcp-stdio] 进程错误 (${name}): ${err.message}`);
    procFail(proc, `MCP 服务器进程失败：${err.message}`);
  });
  child.stderr?.on("data", () => {
    // stderr 仅丢弃（MCP 服务器普遍往 stderr 写日志）。
  });
  return proc;
}

function settleLine(proc: McpProc, line: string): void {
  // 按行找 id 关联：MCP JSON-RPC 回包带 id；notification 无 id（不该
  // 出现在 stdout，忽略）。id 以 JSON 字符串形式匹配 waiter。
  let id: string | null = null;
  try {
    const obj = JSON.parse(line) as { id?: unknown };
    if (obj.id !== undefined) id = String(obj.id);
  } catch {
    // 非 JSON 行（启动横幅等）忽略
    return;
  }
  if (id === null) return;
  const waiter = proc.waiters.get(id);
  if (waiter) {
    proc.waiters.delete(id);
    const t = proc.timers.get(id);
    if (t) {
      clearTimeout(t);
      proc.timers.delete(id);
    }
    waiter(line);
  }
}

/** 进程退出/收割：在途请求立即失败（不会回 200 空体）。 */
function procFail(proc: McpProc, message: string): void {
  if (!proc.alive) return;
  proc.alive = false;
  if (proc.idleTimer) {
    clearTimeout(proc.idleTimer);
    proc.idleTimer = undefined;
  }
  const name = [...procs.entries()].find(([, p]) => p === proc)?.[0];
  if (name) procs.delete(name);
  for (const settle of proc.waiters.values()) settle(null);
  proc.waiters.clear();
  for (const t of proc.timers.values()) clearTimeout(t);
  proc.timers.clear();
  console.error(`[mcp-stdio] ${message}`);
}

/** 处理一条 stdio MCP 隧道请求（relay/index.ts 调用）。 */
export function handleStdioMcpRequest(
  req: McpTunnelRequest,
  cb: McpTunnelCallbacks,
): { abort(): void } {
  const bodyText = req.body ?? "";
  const jsonId = extractId(bodyText);

  // notification（无 id）：写入即回 202，不等响应。
  if (jsonId === null) {
    const proc = getProc(req.name, req.spawn);
    if (!proc) {
      cb.onHead(500, "application/json");
      cb.onData(JSON.stringify({ error: "MCP 服务器进程启动失败" }));
      cb.onEnd();
      return { abort: () => undefined };
    }
    proc.child.stdin?.write(bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`);
    cb.onHead(202, "application/json");
    cb.onData("{}");
    cb.onEnd();
    return { abort: () => undefined };
  }

  const proc = getProc(req.name, req.spawn);
  if (!proc) {
    cb.onHead(500, "application/json");
    cb.onData(JSON.stringify({ error: "MCP 服务器进程启动失败" }));
    cb.onEnd();
    return { abort: () => undefined };
  }

  let done = false;
  const timeout = setTimeout(() => {
    if (done) return;
    done = true;
    proc.waiters.delete(jsonId);
    proc.timers.delete(jsonId);
    cb.onHead(504, "application/json");
    cb.onData(JSON.stringify({ error: "MCP 服务器响应超时（600s）" }));
    cb.onEnd();
  }, 600_000);

  proc.waiters.set(jsonId, (line) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    proc.timers.delete(jsonId);
    if (line === null) {
      // 进程死亡/收割：回失败而非 200 空体。
      cb.onHead(502, "application/json");
      cb.onData(JSON.stringify({ error: "MCP 服务器进程已退出" }));
      cb.onEnd();
      return;
    }
    cb.onHead(200, "application/json");
    cb.onData(line);
    cb.onEnd();
  });
  proc.timers.set(jsonId, timeout);

  proc.child.stdin?.write(bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`);

  return {
    abort: () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      proc.waiters.delete(jsonId);
      proc.timers.delete(jsonId);
    },
  };
}

/** 从 JSON-RPC 请求体取 id（无法解析 = 视为 notification）。 */
function extractId(body: string): string | null {
  try {
    const obj = JSON.parse(body) as { id?: unknown };
    if (obj.id === undefined) return null;
    return String(obj.id);
  } catch {
    return null;
  }
}

/** 登出/断开中继时清理全部子进程。 */
export function shutdownStdioBridge(): void {
  for (const name of [...procs.keys()]) killIdle(name);
}
