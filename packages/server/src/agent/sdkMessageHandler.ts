import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ServerMessage, ToolCallBlock, ToolResultBlock, Usage } from "@blm/protocol";
import { config } from "../config.js";
import { sanitizeToolName } from "./mcp.js";
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
}

/** Translate one raw SDK message into protocol blocks / events. */
export function handleSdkMessage(message: SDKMessage, sid: string, sink: MessageSink): void {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") sink.onEngineSessionId(message.session_id);
      break;

    case "stream_event": {
      const ev = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } })
        .event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        sink.send({ type: "message_delta", session_id: sid, delta: ev.delta.text });
      }
      break;
    }

    case "assistant": {
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
          blocks.push(makeTextBlock(part.text));
        } else if (part.type === "tool_use") {
          blocks.push({
            kind: "tool_call",
            id: part.id,
            tool_name: sanitizeToolName(part.name),
            input: part.input,
          } satisfies ToolCallBlock);
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
            } satisfies ToolResultBlock);
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
