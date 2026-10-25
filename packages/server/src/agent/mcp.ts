import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Built-in in-process tools (SDK MCP server) + user-configured external MCP servers.
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

// Optional external MCP servers from data/mcp.json:
// { "mcpServers": { "fs": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }
function loadExternalServers(): Record<string, unknown> {
  const file = path.join(config.dataDir, "mcp.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export function buildMcpServers(cwd: string): NonNullable<Options["mcpServers"]> {
  return {
    builtin: createBuiltinServer(cwd),
    ...(loadExternalServers() as NonNullable<Options["mcpServers"]>),
  };
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
};

export function sanitizeToolName(raw: string): string {
  const last = raw.includes("__") ? raw.split("__").pop()! : raw;
  return toolNameMap[last] ?? last.toLowerCase();
}
