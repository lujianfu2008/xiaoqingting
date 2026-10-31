import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRecord } from "../store.js";
import { config } from "../config.js";
import { getUserLlmConfig, getUserMaxBudgetUsd, modelSupportsVision } from "../llmConfig.js";
import { relayEnvFor } from "../relay/llmBridge.js";
import { openaiCompatBaseFor } from "../openaiCompat.js";
import type { AgentRole } from "./agents.js";
import { buildMcpServers } from "./mcp.js";
import { clientProxyEntry, clientToolQualifiedNames, type ExecSink } from "./clientTools/index.js";
import { createPublicServer, publicToolQualifiedNames } from "./publicTools.js";
import type { RunAction } from "./clientTools/shared.js";
import { sessionSkillSetup } from "../skillsConfig.js";

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
  // 专家技能：全局 + 我的（公有域会话只挂全局，与 MCP 同规则）。skills 选项
  // 会自行把 Skill 工具放进允许集，无需改角色的 allowedTools。
  const skillSetup = sessionSkillSetup(publicCtx ? undefined : record.user_id);
  // 引擎子进程环境：在服务器完整环境的基础上剥掉仅服务端使用的机密。引擎
  // 认证所需的 ANTHROPIC_* 保留；个人 key 在此注入。引擎里一旦有工具能把
  // 环境变量读进上下文，泄露面就只剩 LLM key，而不是整套服务器机密。
  const engineEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "JWT_SECRET",
    "CREDENTIAL_SECRET",
    "BLMA_USERNAME",
    "BLMA_PASSWORD",
    "BLMA_EMPLOYEE_ID",
    "ASR_API_KEY",
  ]) {
    delete engineEnv[k];
  }
  // 给引擎的 LLM API 请求设超时（CLI 认的 API_TIMEOUT_MS）：上游长时间不吐
  // 响应头时转成重试/报错，而不是无限等。管不到流中途的停摆——那由
  // AgentSession 的回合看门狗兜底。
  engineEnv.API_TIMEOUT_MS = String(process.env.API_TIMEOUT_MS ?? "180000");
  if (llm) {
    // ANTHROPIC_AUTH_TOKEN wins over ANTHROPIC_API_KEY in the SDK, hence it
    // must be explicitly cleared when using a personal key.
    engineEnv.ANTHROPIC_AUTH_TOKEN = undefined;
    engineEnv.ANTHROPIC_API_KEY = llm.api_key;
    engineEnv.ANTHROPIC_BASE_URL = llm.base_url?.trim() || undefined;
    engineEnv.ANTHROPIC_MODEL = undefined; // model 只经 options.model 传入
  }
  // OpenAI 协议网关：引擎的 Anthropic 请求发往本地翻译层（鉴权/真实目标都在
  // 服务端处置）。适配层未启动（理论上仅启动早期）则维持原样。
  const compatBase = llm?.protocol === "openai" ? openaiCompatBaseFor() : null;
  if (llm && compatBase) {
    engineEnv.ANTHROPIC_BASE_URL = `${compatBase}/t/${encodeURIComponent(record.user_id)}`;
  }
  // 网络中继（消息级 LLM 桥）：管理员总开关 + 用户 opt-in 同时开启时，引擎的
  // LLM base_url 指向该用户的本地桥端口，请求作为 WS 消息由桌面端代发。桌面
  // 暂离也注入（桥回 503 JSON，走既有 agent_error 路径，桌面重连后自动恢复，
  // 会话无需重建）；中继关闭时不注入，行为与现状一致。放在 llm 块之后覆盖
  // 个人 base_url——真实目标由桥在每条请求里给桌面端。OpenAI 协议时不覆盖：
  // 引擎已指向翻译层，翻译层自己决定是否经桥发上游。
  const relay = relayEnvFor(record.user_id);
  if (relay && !compatBase) {
    engineEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${relay.port}`;
  }
  // 费用上限：用户「我的大模型」里的设置优先（0 = 不限）；未设置跟全局
  // MAX_BUDGET_USD（<=0 = 不限）。上限耗尽时 CLI 会静默僵死，由回合看门狗
  // 兜底并给用户 llm_budget 专文案。
  const userBudget = getUserMaxBudgetUsd(record.user_id);
  const budgetCap = userBudget !== undefined ? userBudget : config.maxBudgetUsd;
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
          // 公有域会话只挂内置 + 全局 MCP：用户级远程服务器是个人配置，
          // 不进入共享基础设施（其内容可能不可信）。
          ...buildMcpServers(config.engineCwd),
          public: createPublicServer(publicCtx.run),
        }
      : {
          ...buildMcpServers(config.engineCwd, record.user_id),
          client: clientProxyEntry(execSink, record.session_id, attachmentMode),
        },
    includePartialMessages: true,
    settingSources: [],
    ...(skillSetup.plugins.length > 0 && skillSetup.skills.length > 0
      ? { plugins: skillSetup.plugins, skills: skillSetup.skills }
      : {}),
    maxTurns: config.maxTurns,
    // MAX_BUDGET_USD <= 0 = 不设费用上限（不传该选项）。上限耗尽时 CLI 会
    // 静默僵死（见 AgentSession 的 llm_budget 处理），不限时要靠 maxTurns
    // 和回合看门狗兜底失控循环。
    ...(budgetCap > 0 ? { maxBudgetUsd: budgetCap } : {}),
    abortController,
    canUseTool: (toolName, input) => {
      // Client-proxied tools are confirmed by the client itself before
      // execution — auto-allow here to avoid double prompting. Public
      // workspace tools likewise (审批门在 write_file 工具体内). Skill 只注入
      // 指令文本，TodoWrite 只维护任务清单，内置 server_time 只读，均无副作用。
      if (
        toolName === "Skill" ||
        toolName === "TodoWrite" ||
        toolName.startsWith("mcp__blm-builtin__") ||
        clientToolQualifiedNames().includes(toolName) ||
        publicToolQualifiedNames().includes(toolName)
      ) {
        return Promise.resolve({ behavior: "allow" as const });
      }
      // 引擎原生（服务器侧）内建工具一律直接拒绝、不弹确认：架构上一切执行
      // 都在用户本机（client 代理）或外部 MCP 服务器上。allowedTools 只是
      // 免确认白名单而非排他清单，CLI 内建工具集还随版本增长（PowerShell 就
      // 曾漏出角色的禁用名单）——按「非白名单即拒绝」兜底，防止内建工具把
      // 服务器环境变量读进模型上下文（其中含用户 LLM key）。
      if (!toolName.startsWith("mcp__")) {
        return Promise.resolve({
          behavior: "deny" as const,
          message:
            "此为引擎内部工具，已被禁用。请改用可用的本机工具（run_command/read_file/write_file/browser_* 等）或外部 MCP 工具完成同样的操作。",
        });
      }
      // 外部 MCP 工具（mcp__<server>__<tool>）仍走用户确认。
      return requestPermission(toolName, input);
    },
    resume: record.engine_session_id ?? undefined,
    env: engineEnv,
  };
}
