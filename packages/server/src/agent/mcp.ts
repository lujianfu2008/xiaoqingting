import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerDef } from "@blm/protocol";
import { mergeMcpServers, getUserServers } from "../mcpConfig.js";
import { mcpTunnelUrlFor } from "../relay/mcpIngress.js";

// Built-in in-process tools (SDK MCP server) + configured external MCP servers
// (global data/mcp.json — server-direct; per-user data/mcp-users.json —
// tunnelled to the owner's desktop via relay/mcpIngress, merged in mcpConfig).
// The SDK MCP server is created per-session so tools can access that session's workspace.

function createBuiltinServer(_cwd: string) {
  const serverTime = tool(
    "server_time",
    "获取服务器当前时间",
    {},
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "blm-builtin",
    version: "1.0.0",
    tools: [serverTime],
  });
}

// Optional external MCP servers (see mcpConfig.ts for storage and merging):
// data/mcp.json        — global, admin-managed (any transport, server-direct)
// data/mcp-users.json  — per-user (http/sse + stdio), connections ride the
//                        owner's desktop via the MCP tunnel ingress
// Config changes apply to sessions created afterwards; REST writes dispose the
// user's idle sessions so the next message picks them up.
export function buildMcpServers(
  cwd: string,
  userId?: string,
  sessionId?: string,
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {
    builtin: createBuiltinServer(cwd),
  };
  for (const [name, def] of Object.entries(mergeMcpServers(userId).servers)) {
    if (def.enabled === false) continue;
    servers[name] = toSdkConfig(name, def, userId, sessionId);
  }
  return servers;
}

/**
 * 用户级服务器（含同名覆盖全局的条目）改写为桌面隧道：引擎拿到的是
 * 指向本地 ingress 的 http 地址——真实目标/spawn 参数由 ingress 逐请求
 * 发给主人桌面，command/env 等不进引擎面。用户级未配置的（纯全局）
 * 保持原样由服务端直连。入口未就绪（启动早期）也保持原样。
 */
function toSdkConfig(
  name: string,
  def: McpServerDef,
  userId?: string,
  sessionId?: string,
): NonNullable<Options["mcpServers"]>[string] {
  const tunnel =
    userId && sessionId
      ? getUserServers(userId)[name]
        ? mcpTunnelUrlFor(userId, sessionId, name)
        : null
      : null;
  if (tunnel) {
    console.info(
      `[mcp] 用户级服务器 ${name} 已改写为隧道（主人 ${userId}，会话 ${sessionId}）`,
    );
    return { type: "http", url: tunnel };
  }
  if (def.type === "stdio") {
    return { type: "stdio", command: def.command ?? "", args: def.args, env: def.env };
  }
  return def.type === "http"
    ? { type: "http", url: def.url ?? "", headers: def.headers }
    : { type: "sse", url: def.url ?? "", headers: def.headers };
}

// Sanitize engine tool names before they reach the client:
// "mcp__blm-builtin__server_time" -> "server_time", "Read" -> "read_file"
const toolNameMap: Record<string, string> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Bash: "run_command",
  Glob: "find_files",
  Grep: "search_text",
  TodoWrite: "task_list",
  WebFetch: "fetch_url",
  WebSearch: "web_search",
  NotebookEdit: "edit_notebook",
  Task: "delegate_task", // 旧名，0.3.x 已更名 Agent（保留兼容）
  Agent: "delegate_task",
  ListAgents: "list_agents",
  AskUserQuestion: "ask_user",
  Skill: "use_skill",
};

export function sanitizeToolName(raw: string): string {
  const last = raw.includes("__") ? raw.split("__").pop()! : raw;
  return toolNameMap[last] ?? last.toLowerCase();
}
