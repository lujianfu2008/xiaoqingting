import type { Block, FlowAction, SessionMeta, TaskStatus } from "@blm/protocol";

// 协作流状态/动作中文标签（与 MessageBlock 的渲染行保持一致）。
const FLOW_STATUS_LABEL: Record<TaskStatus, string> = {
  analyzing: "需求分析",
  developing: "研发中",
  fixing: "修复中",
  testing: "测试中",
  done: "已完成",
};
const FLOW_ACTION_LABEL: Record<FlowAction, string> = {
  assign_dev: "指派研发",
  submit_test: "提交测试",
  assign_tester: "指派测试",
  report_issue: "反馈问题",
  resubmit: "重新提测",
  pass: "测试通过",
};

// 把一个会话的 blocks 拼成可读的 Markdown：标题 + 导出时间头部，
// user_text/text 按角色分节，工具调用与输出用 fenced code。
export function blocksToMarkdown(meta: SessionMeta | undefined, blocks: Block[]): string {
  const lines: string[] = [];
  lines.push(`# ${meta?.title ?? "会话"}`);
  lines.push("");
  lines.push(`> 导出时间：${new Date().toLocaleString()}`);
  lines.push("");
  for (const b of blocks) {
    switch (b.kind) {
      case "user_text":
        lines.push("## 用户");
        lines.push("");
        lines.push(b.text);
        lines.push("");
        break;
      case "text":
        lines.push("## 助手");
        lines.push("");
        lines.push(b.text);
        lines.push("");
        break;
      case "tool_call":
        lines.push(`### 🔧 ${b.tool_name}`);
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(b.input ?? {}, null, 2));
        lines.push("```");
        lines.push("");
        break;
      case "tool_result":
        lines.push(`### ${b.is_error ? "⚠ 工具输出（错误）" : "工具输出"}`);
        lines.push("");
        lines.push("```");
        lines.push(b.content);
        lines.push("```");
        lines.push("");
        break;
      case "flow_event": {
        const targets = b.targets?.length ? ` → ${b.targets.join("、")}` : "";
        lines.push(
          `> 🔄 ${b.actor} ${FLOW_ACTION_LABEL[b.action]}${targets}（${FLOW_STATUS_LABEL[b.from_status]} → ${FLOW_STATUS_LABEL[b.to_status]}）${b.note ? `\n> 💬 ${b.note}` : ""}`,
        );
        lines.push("");
        break;
      }
    }
  }
  return lines.join("\n");
}
