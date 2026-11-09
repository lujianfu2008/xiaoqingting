import type { Block, LegacyFlowAction, LegacyTaskStatus } from "@blm/protocol";

// 协作流事件的一行文案（会话时间线渲染与 Markdown 导出共用）。
// 历史 flow_event 块嵌旧枚举字面量（五状态/七动作，迁移时不改写），新事件用
// v2 四动作并自带环节名——按 from_stage_name 有无分流。两处调用点共用本函数，
// 避免标签表各存一份副本。

const LEGACY_FLOW_STATUS_LABEL: Record<LegacyTaskStatus, string> = {
  analyzing: "需求分析",
  developing: "研发中",
  fixing: "修复中",
  testing: "测试中",
  done: "已完成",
};
const LEGACY_FLOW_ACTION_LABEL: Record<LegacyFlowAction, string> = {
  assign_dev: "指派研发",
  submit_test: "提交测试",
  assign_tester: "指派测试",
  report_issue: "反馈问题",
  resubmit: "重新提测",
  pass: "测试通过",
  cancel: "取消任务",
};

export function flowEventText(block: Extract<Block, { kind: "flow_event" }>): string {
  const targets = block.targets?.length ? ` → ${block.targets.join("、")}` : "";
  if (block.from_stage_name) {
    // v2 事件：环节名自包含。assign 的 from_stage_name 即目标环节名。
    switch (block.action) {
      case "assign":
        return `🔄 ${block.actor} 指派「${block.from_stage_name}」${targets}`;
      case "cancel":
        return `🔄 ${block.actor} 取消任务`;
      case "advance":
        return `🔄 ${block.actor} 推进（${block.from_stage_name} → ${block.to_stage_name ?? "已完成"}）`;
      case "send_back":
        return `🔄 ${block.actor} 打回（${block.from_stage_name} → ${block.to_stage_name ?? block.from_stage_name}）`;
      default:
        return `🔄 ${block.actor} ${block.action}${targets}`;
    }
  }
  // 历史事件：旧枚举查表，未知值原样兜底。
  return `🔄 ${block.actor} ${LEGACY_FLOW_ACTION_LABEL[block.action as LegacyFlowAction] ?? block.action}${targets}（${LEGACY_FLOW_STATUS_LABEL[block.from_status as LegacyTaskStatus] ?? block.from_status} → ${LEGACY_FLOW_STATUS_LABEL[block.to_status as LegacyTaskStatus] ?? block.to_status}）`;
}
