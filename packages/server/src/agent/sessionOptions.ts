import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRecord } from "../store.js";
import { config } from "../config.js";
import { getUserLlmConfig, modelSupportsVision } from "../llmConfig.js";
import type { AgentRole } from "./agents.js";
import { buildMcpServers } from "./mcp.js";
import { clientProxyEntry, clientToolQualifiedNames, type ExecSink } from "./clientTools/index.js";
import { createPublicServer, publicToolQualifiedNames } from "./publicTools.js";
import type { RunAction } from "./clientTools/shared.js";

export type PermissionDecider = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

/** 公有域会话上下文：存在时文件工具走服务端 public 执行器（role 已经 toPublicRole 变换）。 */
export interface PublicSessionCtx {
  run: RunAction;
  role: AgentRole;
}

/**
 * Build the SDK query options for a session.
 *
 * Per-user LLM credentials: the *session owner's* config (shared sessions
 * opened by a collaborator still run on the owner's model/key). Unset → fall
 * back to the process environment (global default).
 */
export function buildSessionOptions(
  record: SessionRecord,
  role: AgentRole,
  execSink: ExecSink,
  abortController: AbortController,
  requestPermission: PermissionDecider,
  publicCtx?: PublicSessionCtx,
): Options {
  const llm = getUserLlmConfig(record.user_id);
  // 公有域会话：工具/提示词换成公域变体；cwd 仍用中立 engine 目录，避免把
  // 公有工作空间里的文件（可能被投喂）当作 CLAUDE.md 等注入引擎上下文。
  const effectiveRole = publicCtx?.role ?? role;
  // 附件读取模式跟模型走：能看图直接回图，否则降级为本机 OCR 文字。
  const attachmentMode: "image" | "ocr" =
    modelSupportsVision(llm?.model?.trim() || effectiveRole.model) ? "image" : "ocr";
  return {
    // Neutral engine cwd — the SDK injects it into the model's context, so
    // it must never reveal user workspace paths. All real operations happen
    // on the user's machine via the client proxy tools (公有域会话则在服务端
    // public 执行器上执行).
    cwd: config.engineCwd,
    model: llm?.model?.trim() || effectiveRole.model,
    systemPrompt: effectiveRole.systemPrompt,
    allowedTools: effectiveRole.allowedTools,
    disallowedTools: effectiveRole.disallowedTools,
    permissionMode: effectiveRole.permissionMode,
    agents: effectiveRole.agents,
    mcpServers: publicCtx
      ? {
          ...buildMcpServers(config.engineCwd),
          public: createPublicServer(publicCtx.run),
        }
      : {
          ...buildMcpServers(config.engineCwd),
          client: clientProxyEntry(execSink, record.session_id, attachmentMode),
        },
    includePartialMessages: true,
    settingSources: [],
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    abortController,
    canUseTool: (toolName, input) => {
      // Client-proxied tools are confirmed by the client itself before
      // execution — auto-allow here to avoid double prompting. Public
      // workspace tools likewise (审批门在 write_file 工具体内).
      if (
        clientToolQualifiedNames().includes(toolName) ||
        publicToolQualifiedNames().includes(toolName)
      ) {
        return Promise.resolve({ behavior: "allow" as const });
      }
      return requestPermission(toolName, input);
    },
    resume: record.engine_session_id ?? undefined,
    // Options.env REPLACES the subprocess environment entirely, so spread
    // process.env. ANTHROPIC_AUTH_TOKEN wins over ANTHROPIC_API_KEY in the
    // SDK, hence it must be explicitly cleared when using a personal key.
    ...(llm
      ? {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: llm.api_key,
            ANTHROPIC_AUTH_TOKEN: undefined,
            ANTHROPIC_BASE_URL: llm.base_url?.trim() || undefined,
            ANTHROPIC_MODEL: undefined, // model only via options.model
          },
        }
      : {}),
  };
}
