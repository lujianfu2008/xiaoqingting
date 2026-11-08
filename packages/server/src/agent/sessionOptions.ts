import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRecord } from "../store.js";
import { config } from "../config.js";
import { getUserLlmConfig, getUserMaxBudgetUsd, modelSupportsVision } from "../llmConfig.js";
import { relayIngressFor } from "../relay/llmBridge.js";
import { openaiCompatBaseFor } from "../openaiCompat.js";
import type { AgentRole } from "./agents.js";
import { buildMcpServers } from "./mcp.js";
import { clientProxyEntry, clientToolQualifiedNames, type ExecSink } from "./clientTools/index.js";
import { createPublicServer, publicToolQualifiedNames } from "./publicTools.js";
import type { RunAction } from "./clientTools/shared.js";
import { sessionSkillSetup } from "../skillsConfig.js";
import { subagentName } from "./subagents.js";

export type PermissionDecider = (
  toolName: string,
  input: Record<string, unknown>,
  agent?: { agent_id: string; agent_name: string },
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

/**
 * 子代理委派闸门：入参校验 + 并发/频次上限。由 AgentSession 创建持有
 * （生命周期随会话），canUseTool 在放行 Agent 工具前裁决；task_started/
 * task_notification 消息驱动在飞记账（回调见 sdkMessageHandler）。
 */
export interface DelegationGate {
  /** 放行前裁决：ok=放行；否则拒绝分类（次数/并发满=cap、类型未知、远端隔离）。 */
  tryStart(
    input: Record<string, unknown>,
    allowedKeys: string[],
    toolUseId: string,
  ): "ok" | "cap" | "unknown_type" | "remote";
  /** task_id → 子代理 key 查询（审批弹窗标注请求来源子代理）。 */
  keyForTask(taskId: string): string | undefined;
  /** task_started 边界：登记在飞委派的后台确认与 task_id 映射。 */
  markTaskStarted(
    taskId: string,
    toolUseId: string | undefined,
    key: string | undefined,
  ): void;
  /** task_notification 边界：委派结算（完成/失败/停止都算），释放在飞占用。 */
  releaseTask(taskId: string): void;
  /** 委派 tool_result 结算（老 CLI 无 task 事件时的兜底释放；已确认后台的不在此释放）。 */
  releaseToolUse(toolUseId: string): void;
  /** 回合结束：清零每回合委派计数（在飞占用跨回合保留——后台子代理活得比回合久）。 */
  resetTurn(): void;
  /** 当前在飞委派数（空闲回收联动用）。 */
  readonly inFlight: number;
}

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
  delegationGate: DelegationGate,
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
  // 服务端处置）。适配层未启动（理论上仅启动早期）则维持原样。路径带 session_id：
  // 翻译层据此在请求时解析「当前负责人」决定借哪台桌面代发（工作台跟随指派）。
  const compatBase = llm?.protocol === "openai" ? openaiCompatBaseFor() : null;
  if (llm && compatBase) {
    engineEnv.ANTHROPIC_BASE_URL = `${compatBase}/t/${encodeURIComponent(record.user_id)}/s/${encodeURIComponent(record.session_id)}`;
  }
  // 网络中继（消息级 LLM 桥）：管理员总开关开启且主人或当前负责人 opt-in 时，
  // 引擎的 LLM base_url 指向共享中继入口，请求作为 WS 消息由某台桌面端代发。
  // 入口地址**不写死代发人**——代发人逐请求解析（负责人优先、主人兜底），
  // 任务流转换负责人无需重建会话。桌面此刻全离线也注入：请求时回 503 走既有
  // agent_error 路径，任一桌面重连后下一条消息自动恢复。放在 llm 块之后覆盖
  // 个人 base_url——真实目标由入口在每条请求里给桌面端。OpenAI 协议时不覆盖：
  // 引擎已指向翻译层，翻译层自己决定是否借桌面发上游。
  const relayBase = relayIngressFor(record.user_id, record.session_id);
  if (relayBase && !compatBase) {
    engineEnv.ANTHROPIC_BASE_URL = relayBase;
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
    canUseTool: (toolName, input, options) => {
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
        // 精确豁口：主线程委派子代理。仅配置了 agents 的角色放行，且：
        // - options.agentID 非空 = 已在子代理上下文——二道锁直接拒绝，防止
        //   孙子代理（即使子代理 tools 白名单配错也委派不出去）；
        // - isolation:"remote" 会把子代理放进远端云环境，脱离「一切执行在
        //   用户本机」的模型，拒绝（worktree 落在服务端中立 engine 目录内，
        //   仅占磁盘，放行）；
        // - subagent_type 必须属于角色配置的键集；并发/频次由闸门裁决。
        if (
          (toolName === "Agent" || toolName === "ListAgents") &&
          effectiveRole.agents &&
          Object.keys(effectiveRole.agents).length > 0
        ) {
          const keys = Object.keys(effectiveRole.agents);
          if (toolName === "ListAgents") {
            return Promise.resolve({ behavior: "allow" as const });
          }
          if (options.agentID) {
            return Promise.resolve({
              behavior: "deny" as const,
              message:
                "子代理不能再委派其他子代理。请把调研或执行结论直接写进你自己的报告。",
            });
          }
          const gate = delegationGate.tryStart(input, keys, options.toolUseID);
          if (gate === "ok") {
            return Promise.resolve({ behavior: "allow" as const });
          }
          return Promise.resolve({
            behavior: "deny" as const,
            message:
              gate === "cap"
                ? `并行子代理已达上限（${config.maxConcurrentSubagents} 个）或本回合委派次数已用完（${config.maxDelegationsPerTurn} 次），请等待当前委派完成后再发起新的。`
                : gate === "remote"
                  ? "不支持在远端云环境运行子代理，请在用户本机完成该任务。"
                  : `未知的 subagent_type，可用值：${keys.join("、")}。`,
          });
        }
        return Promise.resolve({
          behavior: "deny" as const,
          message:
            "此为引擎内部工具，已被禁用。请改用可用的本机工具（run_command/read_file/write_file/browser_* 等）或外部 MCP 工具完成同样的操作。",
        });
      }
      // 外部 MCP 工具（mcp__<server>__<tool>）仍走用户确认；请求若来自子代理，
      // 带上归属（客户端弹窗标注「子代理 xx 请求使用 …」）。
      const agentKey = options.agentID
        ? delegationGate.keyForTask(options.agentID)
        : undefined;
      return requestPermission(
        toolName,
        input,
        agentKey ? { agent_id: agentKey, agent_name: subagentName(agentKey) } : undefined,
      );
    },
    resume: record.engine_session_id ?? undefined,
    env: engineEnv,
  };
}
