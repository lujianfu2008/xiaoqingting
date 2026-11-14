import type { Block, LegacyFlowAction, LegacyTaskStatus, SessionMeta } from "@blm/protocol";

// 服务端会话导出：把一个会话的 blocks 拼成可读的 Markdown
// （GET /api/sessions/:id/export 的下载体）。与桌面端 lib/exportMarkdown
// 的结构保持同构：标题 + 导出时间头部，user_text/text 按角色分节，
// 工具调用与输出折叠进 <details>，任务清单/协作流事件用一行摘要。
// 桌面端还有"保存对话框"交互，服务端只负责内容。

const RESULT_TRUNCATE = 2000;

/** 协作流事件一行文案（与桌面端 lib/flowEvent 同表，旧枚举兼容）。 */
const LEGACY_FLOW_STATUS: Record<string, string> = {
  analyzing: "需求分析",
  developing: "研发中",
  fixing: "修复中",
  testing: "测试中",
  done: "已完成",
};
const LEGACY_FLOW_ACTION: Record<string, string> = {
  assign_dev: "指派研发",
  submit_test: "提交测试",
  assign_tester: "指派测试",
  report_issue: "反馈问题",
  resubmit: "重新提测",
  pass: "测试通过",
  cancel: "取消任务",
};

function flowEventText(b: {
  actor: string;
  action: string;
  from_stage_name?: string;
  to_stage_name?: string;
  targets?: string[];
  from_status: string;
  to_status: string;
}): string {
  const targets = b.targets?.length ? ` → ${b.targets.join("、")}` : "";
  if (b.from_stage_name) {
    // v2 事件：环节名自包含。assign 的 from_stage_name 即目标环节名。
    switch (b.action) {
      case "assign":
        return `🔄 ${b.actor} 指派「${b.from_stage_name}」${targets}`;
      case "cancel":
        return `🔄 ${b.actor} 取消任务`;
      case "advance":
        return `🔄 ${b.actor} 推进（${b.from_stage_name} → ${b.to_stage_name ?? "已完成"}）`;
      case "send_back":
        return `🔄 ${b.actor} 打回（${b.from_stage_name} → ${b.to_stage_name ?? b.from_stage_name}）`;
      default:
        return `🔄 ${b.actor} ${b.action}${targets}`;
    }
  }
  // 历史事件：旧枚举查表，未知值原样兜底。
  return `🔄 ${b.actor} ${LEGACY_FLOW_ACTION[b.action] ?? b.action}${targets}（${LEGACY_FLOW_STATUS[b.from_status] ?? b.from_status} → ${LEGACY_FLOW_STATUS[b.to_status] ?? b.to_status}）`;
}

/** tool_call 输入的摘要：标量取值，对象截短 JSON，其余类型原样。 */
function inputSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    const s = JSON.stringify(input) ?? "";
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(input);
  }
}

function taskListLines(items: { content: string; status: string }[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const mark = it.status === "completed" ? "✅" : it.status === "in_progress" ? "🔨" : "☐";
    out.push(`- ${mark} ${it.content}`);
  }
  return out;
}

export function blocksToMarkdown(
  meta: { title: string; created_at: string; updated_at: string },
  blocks: Block[],
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push("");
  lines.push(`> 导出时间：${new Date().toLocaleString()}`);
  lines.push(`> 会话创建：${meta.created_at}`);
  lines.push(`> 最后更新：${meta.updated_at}`);
  lines.push("");
  for (const b of blocks) {
    switch (b.kind) {
      case "user_text":
        lines.push(`**用户：**`);
        lines.push("");
        lines.push(b.text);
        lines.push("");
        break;
      case "text":
        lines.push(b.text);
        lines.push("");
        break;
      case "tool_call": {
        // 折叠 details：工具名 + 输入摘要。
        lines.push(`<details>`);
        lines.push(`<summary>🔧 ${b.tool_name} — ${inputSummary(b.input)}</summary>`);
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(b.input ?? {}, null, 2));
        lines.push("```");
        lines.push(`</details>`);
        lines.push("");
        break;
      }
      case "tool_result": {
        // 结果截断 2000 字，同入 details。
        const truncated =
          b.content.length > RESULT_TRUNCATE
            ? `${b.content.slice(0, RESULT_TRUNCATE)}\n…（已截断，共 ${b.content.length} 字）`
            : b.content;
        lines.push(`<details${b.is_error ? " open" : ""}>`);
        lines.push(`<summary>${b.is_error ? "⚠ 工具输出（错误）" : "工具输出"}</summary>`);
        lines.push("");
        lines.push("```");
        lines.push(truncated);
        lines.push("```");
        lines.push(`</details>`);
        lines.push("");
        break;
      }
      case "task_list":
        lines.push("📋 **任务清单**");
        lines.push("");
        lines.push(...taskListLines(b.items));
        lines.push("");
        break;
      case "flow_event":
        lines.push(`> ${flowEventText(b)}${b.note ? `\n> 💬 ${b.note}` : ""}`);
        lines.push("");
        break;
    }
  }
  return lines.join("\n");
}
