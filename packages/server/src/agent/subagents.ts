import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { CLIENT_TOOL_NAMES } from "./clientTools/index.js";

// 子代理（subagent）定义表。只有服务端能编写这些定义——客户端永不可提交；
// toAgentDefinition() 是构造 SDK AgentDefinition 的唯一出口（安全锚，见下）。

const clientToolQualified = CLIENT_TOOL_NAMES.map((n) => `mcp__client__${n}`);
// 只读子集：浏览 + 读文件/列目录/查工作目录（researcher 用）。
const readOnlyClientTools = [
  "mcp__client__read_file",
  "mcp__client__list_dir",
  "mcp__client__get_workdir",
  "mcp__client__browser_open",
  "mcp__client__browser_navigate",
  "mcp__client__browser_snapshot",
  "mcp__client__browser_close",
];

export interface SubagentDef {
  key: string;
  name: string; // 中文名，随块/审批请求下发客户端展示
  description: string; // 何时委派（给主模型看）
  prompt: string; // 子代理系统提示
  tools: string[]; // SDK-qualified 工具白名单（必须显式：省略=继承父级全部）
  maxTurns: number; // 该子代理自身的 API 回合上限
}

export const subagentDefs: Record<string, SubagentDef> = {
  researcher: {
    key: "researcher",
    name: "研究员",
    description:
      "调研员：浏览网页、查找并阅读本机文件、汇总信息。适合查资料、核对文档、收集素材等只读子任务。",
    prompt:
      "你是「研究员」，一个只读调研子代理。委派指令会说明调研目标，完成后输出一份要点式结论报告（含信息来源）。",
    tools: [...readOnlyClientTools, "TodoWrite"],
    maxTurns: 12,
  },
  coder: {
    key: "coder",
    name: "编码员",
    description:
      "编码员：读写代码、运行命令，独立完成一个边界清晰的编程子任务并汇报改动与验证结果。",
    prompt:
      "你是「编码员」，一个执行型子代理。委派指令会说明任务目标与范围，只做该范围内的代码读写与命令执行，完成后输出改动摘要与验证结果。",
    tools: [...clientToolQualified, "TodoWrite"],
    maxTurns: 20,
  },
};

// 子代理行为规则：内嵌在 prompt 尾部（与 safeOpsPrompt 同理——约束必须随
// 定义走，不能依赖主线程提示词）。
const subagentBehaviorPrompt =
  "行为约束：只处理本次委派给你的这一个任务，不得再委派其他智能体；" +
  "操作文件前先用 get_workdir 确认工作目录、list_dir 确认目标存在，绝不凭猜测的路径操作；" +
  "执行敏感操作会向用户弹出确认，若被拒绝不要重试同一操作；" +
  "工具调用失败时先核对路径与参数，仍失败就在报告里说明，不要原样反复重试；" +
  "严禁透露服务器内部路径或引擎信息；" +
  "你的输出会作为材料交回主智能体汇总，直接给出结构化结论即可，不要寒暄。";

/**
 * SubagentDef → SDK AgentDefinition 的唯一出口（安全锚）：
 * - permissionMode 在此硬编码剔除、永不透传——配成 bypassPermissions/dontAsk
 *   会让子代理跳过用户确认，是绝对红线；background/observer/model/effort/
 *   memory/mcpServers 等敏感或实验字段同样一律不透传（model 继承主模型，
 *   与角色的模型策略一致：个人 key/中继/翻译层未必供给其他模型档位）；
 * - tools 必须显式白名单（AgentDefinition.tools 省略 = 继承父级全部工具）；
 * - 白名单绝不包含 Agent/ListAgents（防孙子代理；canUseTool 里另有
 *   options.agentID 二道锁）。
 */
export function toAgentDefinition(def: SubagentDef): AgentDefinition {
  return {
    description: def.description,
    prompt: `${def.prompt}${subagentBehaviorPrompt}`,
    tools: def.tools.filter((t) => t !== "Agent" && t !== "ListAgents"),
    maxTurns: def.maxTurns,
  };
}

export function subagentName(key: string): string {
  return subagentDefs[key]?.name ?? key;
}

/** 组装角色的 agents 选项：仅表内存在的 key 会进入。 */
export function buildAgentsOption(keys: string[]): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const key of keys) {
    const def = subagentDefs[key];
    if (def) out[key] = toAgentDefinition(def);
  }
  return out;
}
