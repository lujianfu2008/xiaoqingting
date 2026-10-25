import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { browserTools } from "./browserTools.js";
import { fileTools } from "./fileTools.js";

// Tools that execute on the USER'S machine. Each tool body proxies the action
// over WebSocket to the client (tool_exec_request / tool_exec_result).
// The engine just sees a normal MCP tool server; no engine details exist on the client.

export interface ExecSink {
  /** Send a tool_exec_request to the owning client and resolve with its result. */
  requestClientExec(
    sessionId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; output?: string; error?: string }>;
}

export const CLIENT_TOOL_NAMES = [
  "run_command",
  "read_file",
  "read_attachment",
  "write_file",
  "list_dir",
  "get_workdir",
  "choose_workdir",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_close",
] as const;

// SDK-qualified names for permission auto-allow: mcp__client__<tool>
export function clientToolQualifiedNames(): string[] {
  return CLIENT_TOOL_NAMES.map((n) => `mcp__client__${n}`);
}

export function createClientProxyServer(
  sink: ExecSink,
  sessionId: string,
  attachmentMode: "image" | "ocr",
) {
  const run = (
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => sink.requestClientExec(sessionId, action, params, timeoutMs);

  return createSdkMcpServer({
    name: "client",
    version: "1.0.0",
    tools: [...fileTools(run, attachmentMode), ...browserTools(run)],
  });
}

// Used when building Options.mcpServers
export function clientProxyEntry(
  sink: ExecSink,
  sessionId: string,
  attachmentMode: "image" | "ocr",
): NonNullable<Options["mcpServers"]>[string] {
  return createClientProxyServer(sink, sessionId, attachmentMode);
}
