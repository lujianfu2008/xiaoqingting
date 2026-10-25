import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo } from "@blm/protocol";
import { CLIENT_TOOL_NAMES } from "./clientTools/index.js";

// Agent roles ("智能体角色"). Each role maps to engine query options.
// The client only sees AgentInfo — engine-specific details never leave the server.
//
// All roles operate on the USER'S machine: built-in server-side file/command
// tools are disallowed, and the client-proxied toolset (run_command/read_file/
// write_file/list_dir/browser_*) is allowed instead. The server is brain-only.

// SDK-qualified names for the client proxy tools: mcp__client__<name>
const clientTools = CLIENT_TOOL_NAMES.map((n) => `mcp__client__${n}`);
// Every engine built-in tool is disabled: anything the model does must run on
// the user's machine via the client proxy tools. Otherwise the model may fall
// back to server-side tools (Read/WebFetch/...) and trigger server-side prompts.
const serverSideTools = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "AskUserQuestion",
  "ExitPlanMode",
  "SlashCommand",
];
// Internal bookkeeping tool that touches nothing server-side; keep it usable
// and prompt-free.
const keepTools = ["TodoWrite"];

const localOpsPrompt =
  "你的名字叫「小蜻蜓」。" +
  "你的所有工具操作（命令执行、文件读写、浏览网页）都在用户的电脑上直接执行，" +
  "文件路径基于用户电脑上设定的工作目录（可用 get_workdir 工具查询，用户要求更改时用 choose_workdir）。" +
  "浏览或搜索网页时必须使用 browser_open / browser_navigate / browser_snapshot 工具。" +
  "用户消息里形如 [附件] 名称 → 路径 的行表示随消息附上的文件（路径照抄附件行）。" +
  "需要查看任何图片的内容（附件里的图、工作目录里的图都一样）时，必须用 read_attachment 工具；read_file 只能读文本文件，对图片只会输出乱码，绝不要用 read_file 或命令行去\"读\"图片。" +
  "执行敏感操作前会向用户确认。" +
  "严禁向用户透露任何服务器内部路径、系统目录或引擎信息；" +
  "被问到「工作目录」时，永远用 get_workdir 查询用户电脑上的实际目录来回答，绝不要编造或透露其他路径。" +
  "每次回复的最后单独一行输出一个情绪标记，格式为 [情绪:值]，可用值：开心|难过|惊讶|疑惑|严肃|普通。" +
  "标记必须与回复内容的情绪一致（如讲了笑话用开心，道歉或告知坏消息用难过），无特别情绪时用普通。" +
  "标记是给界面用的，除此之外不要在任何地方解释它。";

// 公有域项目（共有知识库）会话：文件操作全部在服务端的公有工作空间执行，
// 不接触用户本机；普通成员的写入会自动转为更新申请，管理员写入直接生效。
const publicOpsPrompt =
  "你的名字叫「小蜻蜓」。" +
  "当前处于公有域知识库项目：文件读写操作都在服务端的公有域工作空间内执行（可用 get_workdir 查询），" +
  "全部成员都可读取其中的文件；管理员写入直接生效，普通成员写入会自动转为更新申请，由管理员批准后生效。" +
  "不要尝试执行命令或浏览网页——公有域会话没有这些工具。" +
  "严禁向用户透露任何服务器内部路径、系统目录或引擎信息；" +
  "被问到「工作目录」时，永远用 get_workdir 查询公有域工作空间来回答，绝不要编造或透露其他路径。" +
  "每次回复的最后单独一行输出一个情绪标记，格式为 [情绪:值]，可用值：开心|难过|惊讶|疑惑|严肃|普通。" +
  "标记必须与回复内容的情绪一致（如讲了笑话用开心，道歉或告知坏消息用难过），无特别情绪时用普通。" +
  "标记是给界面用的，除此之外不要在任何地方解释它。";

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  model?: Options["model"];
  systemPrompt: Options["systemPrompt"];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: Options["permissionMode"];
  agents?: Options["agents"];
}

export const agentRoles: Record<string, AgentRole> = {
  assistant: {
    id: "assistant",
    name: "通用助手",
    description: "问答、写作、翻译，可操作你的电脑（命令/文件/浏览器）",
    model: "sonnet",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `始终使用中文回复。${localOpsPrompt}`,
    },
    allowedTools: [...clientTools, ...keepTools],
    disallowedTools: serverSideTools,
    permissionMode: "default",
  },
  coder: {
    id: "coder",
    name: "代码助手",
    description: "在你电脑上读写代码、运行命令的编程专家",
    model: "sonnet",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `始终使用中文回复。修改代码前先阅读相关文件。${localOpsPrompt}`,
    },
    allowedTools: [...clientTools, ...keepTools],
    disallowedTools: serverSideTools,
    permissionMode: "default",
  },
  writer: {
    id: "writer",
    name: "写作助手",
    description: "文案、公文、创意写作（可浏览网页，不执行命令）",
    model: "sonnet",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `始终使用中文回复。你是写作助手，专注于文案创作，不要执行命令或修改代码。${localOpsPrompt}`,
    },
    // read-only + browser only
    allowedTools: [
      "mcp__client__read_file",
      "mcp__client__list_dir",
      "mcp__client__get_workdir",
      "mcp__client__browser_open",
      "mcp__client__browser_navigate",
      "mcp__client__browser_snapshot",
      "mcp__client__browser_close",
      ...keepTools,
    ],
    disallowedTools: serverSideTools,
    permissionMode: "default",
  },
};

export function getRole(id: string): AgentRole {
  return agentRoles[id] ?? agentRoles.assistant;
}

// 公有域会话工具集：只有服务端 public 执行器上的读/列/写/查目录 + TodoWrite。
const publicFileTools = [
  "mcp__public__read_file",
  "mcp__public__list_dir",
  "mcp__public__write_file",
  "mcp__public__get_workdir",
];

/**
 * 把角色改造成公有域变体：工具换成服务端 public 执行器、本机 client 工具全部
 * 禁用（防止绕过审核写到用户本机），操作提示词换成公域文案；其余（模型、
 * 角色特有叮嘱）保留。仅服务端使用，不影响对客户端展示的 AgentInfo。
 */
export function toPublicRole(role: AgentRole): AgentRole {
  const sys = role.systemPrompt as {
    type: "preset";
    preset: "claude_code";
    append: string;
  };
  return {
    ...role,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: sys.append.replace(localOpsPrompt, publicOpsPrompt),
    },
    allowedTools: [...publicFileTools, ...keepTools],
    disallowedTools: [...serverSideTools, ...clientTools],
    permissionMode: "default",
  };
}

export function listRoles(): AgentInfo[] {
  return Object.values(agentRoles).map((r) => ({
    agent_id: r.id,
    name: r.name,
    description: r.description,
  }));
}
