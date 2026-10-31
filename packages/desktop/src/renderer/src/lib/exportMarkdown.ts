import type { Block, SessionMeta } from "@blm/protocol";

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
    }
  }
  return lines.join("\n");
}
