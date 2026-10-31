import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerDef } from "@blm/protocol";
import { mergeMcpServers } from "../mcpConfig.js";

// Built-in in-process tools (SDK MCP server) + configured external MCP servers
// (global data/mcp.json + per-user remote servers, merged in mcpConfig).
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
// data/mcp.json        — global, admin-managed (any transport)
// data/mcp-users.json  — per-user remote (http/sse only)
// Config changes apply to sessions created afterwards; REST writes dispose the
// user's idle sessions so the next message picks them up.
export function buildMcpServers(
  cwd: string,
  userId?: string,
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {
    builtin: createBuiltinServer(cwd),
  };
  for (const [name, def] of Object.entries(mergeMcpServers(userId).servers)) {
    if (def.enabled === false) continue;
    servers[name] = toSdkConfig(def);
  }
  return servers;
}

function toSdkConfig(def: McpServerDef): NonNullable<Options["mcpServers"]>[string] {
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
  Task: "delegate_task",
  AskUserQuestion: "ask_user",
  Skill: "use_skill",
};

export function sanitizeToolName(raw: string): string {
  const last = raw.includes("__") ? raw.split("__").pop()! : raw;
  return toolNameMap[last] ?? last.toLowerCase();
}
