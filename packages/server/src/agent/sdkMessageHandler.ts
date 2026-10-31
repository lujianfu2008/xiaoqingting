import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ServerMessage, ToolCallBlock, ToolResultBlock, Usage } from "@blm/protocol";
import { config } from "../config.js";
import { sanitizeToolName } from "./mcp.js";
import { subagentName } from "./subagents.js";
import {
  LLM_AUTH_ERROR_MESSAGE,
  isAuthFailureText,
  makeTextBlock,
  stringifyToolContent,
} from "./sdkText.js";

export interface MessageSink {
  send(msg: ServerMessage): void;
  emitBlocks(blocks: Block[]): void;
  /** Persist the engine's session id so the conversation can be resumed. */
  onEngineSessionId(engineSessionId: string): void;
  /** One turn's token usage (accumulated by the caller into the session record). */
  onUsage(usage: Usage): void;
  /** A turn just finished (result delivered) — the caller uses this to arm the
   *  idle reaper while the engine loop stays alive between turns. */
  onTurnEnd?(): void;
  // ---------- 子代理委派记账（回调给 AgentSession 的 DelegationGate） ----------
  /** 主线程发起委派（Agent 工具 tool_use，canUseTool 放行后到达这里）。 */
  onDelegateStart?(toolUseId: string, subagentKey: string): void;
  /** 委派 tool_result 结算（兜底释放；已确认后台的由 task_notification 释放）。 */
  onDelegateEnd?(toolUseId: string): void;
  /** task_started 边界：后台确认 + task_id→toolUseId 映射。 */
  onTaskStarted?(taskId: string, toolUseId: string | undefined, key: string | undefined): void;
  /** task_notification 边界：委派结算（完成/失败/停止都算）。 */
  onTaskNotification?(taskId: string, toolUseId: string | undefined): void;
}

/** SDK 消息的子代理归属 → Block 可选字段子集（主线程消息返回空对象）。 */
function subagentAttrib(message: {
  parent_tool_use_id?: string | null;
  subagent_type?: string;
}): Pick<ToolCallBlock, "agent_id" | "agent_name" | "parent_tool_call_id"> {
  const parent = message.parent_tool_use_id ?? null; // undefined 视同主线程（老 CLI）
  const key = message.subagent_type;
  if (parent == null && !key) return {};
  return {
    ...(key ? { agent_id: key, agent_name: subagentName(key) } : {}),
    ...(parent != null ? { parent_tool_call_id: parent } : {}),
  };
}

/** Translate one raw SDK message into protocol blocks / events. */
export function handleSdkMessage(message: SDKMessage, sid: string, sink: MessageSink): void {
  switch (message.type) {
    case "system": {
      const m = message as {
        subtype?: string;
        session_id?: string;
        task_id?: string;
        tool_use_id?: string;
        subagent_type?: string;
      };
      if (m.subtype === "init") sink.onEngineSessionId(message.session_id);
      else if (m.subtype === "task_started")
        sink.onTaskStarted?.(m.task_id ?? "", m.tool_use_id, m.subagent_type);
      else if (m.subtype === "task_notification")
        sink.onTaskNotification?.(m.task_id ?? "", m.tool_use_id);
      break;
    }

    case "stream_event": {
      // 子代理的流式文本不下发：message_delta 无归属字段，混进主线程流会
      // 串流；且后台子代理的 delta 会在 result 之后「复活」已完结回复的流
      // 缓冲。== null 判定（undefined 视同主线程）兼容无此字段的老 CLI。
      if ((message as { parent_tool_use_id?: string | null }).parent_tool_use_id != null) break;
      const ev = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } })
        .event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        sink.send({ type: "message_delta", session_id: sid, delta: ev.delta.text });
      }
      break;
    }

    case "assistant": {
      const attrib = subagentAttrib(message);
      const blocks: Block[] = [];
      let authFailure = false;
      for (const part of message.message.content) {
        if (part.type === "text" && part.text.trim().length > 0) {
          // The SDK sometimes reports credential problems as a normal
          // assistant reply ("Failed to authenticate. API Error: 401 ...")
          // instead of throwing — surface those as a real error.
          if (isAuthFailureText(part.text)) {
            authFailure = true;
            continue;
          }
          // 子代理文本默认不上时间线（TextBlock 无归属字段；SDK 的
          // forwardSubagentText=false 也本就不转发）——保留错误检测即可。
          if (attrib.agent_id) continue;
          blocks.push(makeTextBlock(part.text));
        } else if (part.type === "tool_use") {
          blocks.push({
            kind: "tool_call",
            id: part.id,
            tool_name: sanitizeToolName(part.name),
            input: part.input,
            ...attrib,
          } satisfies ToolCallBlock);
          // 主线程发起委派：登记闸门在飞账目（子代理内的 Agent 调用已被
          // canUseTool 的 agentID 二道锁拒绝，到不了这里）。
          if (part.name === "Agent" && !attrib.parent_tool_call_id) {
            const key = (part.input as { subagent_type?: unknown })?.subagent_type;
            sink.onDelegateStart?.(part.id, typeof key === "string" ? key : "");
          }
        }
      }
      if (authFailure) {
        sink.send({
          type: "error",
          session_id: sid,
          code: "llm_auth",
          message: LLM_AUTH_ERROR_MESSAGE,
        });
      }
      sink.emitBlocks(blocks);
      break;
    }

    case "user": {
      const attrib = subagentAttrib(message);
      const blocks: Block[] = [];
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            (part as { type?: string }).type === "tool_result"
          ) {
            const tr = part as {
              tool_use_id?: string;
              is_error?: boolean;
              content?: unknown;
            };
            blocks.push({
              kind: "tool_result",
              id: tr.tool_use_id ?? "",
              content: stringifyToolContent(tr.content),
              is_error: tr.is_error ?? false,
              ...attrib,
            } satisfies ToolResultBlock);
            // 委派兜底结算：已确认后台的委派由 task_notification 释放，这里
            // 只兜老 CLI 无 task 事件的场景（前台委派的 tool_result=真结束）。
            sink.onDelegateEnd?.(tr.tool_use_id ?? "");
          }
        }
      }
      sink.emitBlocks(blocks);
      break;
    }

    case "result": {
      // final text is already delivered via assistant messages
      // 用量：token 数恒下发；费用仅在 REVEAL_USAGE 开启时给出数值。
      const raw = message as {
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
        total_cost_usd?: unknown;
      };
      let usage: Usage | undefined;
      if (
        raw.usage &&
        typeof raw.usage.input_tokens === "number" &&
        typeof raw.usage.output_tokens === "number"
      ) {
        usage = {
          input_tokens: raw.usage.input_tokens,
          output_tokens: raw.usage.output_tokens,
          cost_usd:
            config.revealUsage && typeof raw.total_cost_usd === "number"
              ? raw.total_cost_usd
              : null,
        };
      }
      if (usage) sink.onUsage(usage);
      sink.send({
        type: "result",
        session_id: sid,
        is_error: message.subtype !== "success",
        duration_ms: "duration_ms" in message ? message.duration_ms : undefined,
        num_turns: "num_turns" in message ? message.num_turns : undefined,
        usage,
      });
      sink.onTurnEnd?.();
      break;
    }

    default:
      break;
  }
}
