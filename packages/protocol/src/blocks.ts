import { z } from "zod";

// ---------- Blocks (chat message content) ----------

export const TextBlock = z.object({
  kind: z.literal("text"),
  text: z.string(),
  // Emotion tag the model attached to this reply (开心/难过/惊讶/疑惑/严肃/普通).
  // Stripped from `text` server-side; drives avatar expressions on the client.
  emotion: z.string().optional(),
});
export type TextBlock = z.infer<typeof TextBlock>;

export const UserTextBlock = z.object({
  kind: z.literal("user_text"),
  text: z.string(),
});
export type UserTextBlock = z.infer<typeof UserTextBlock>;

export const ToolCallBlock = z.object({
  kind: z.literal("tool_call"),
  id: z.string(),
  tool_name: z.string(), // sanitized, e.g. "read_file"
  input: z.unknown(),
});
export type ToolCallBlock = z.infer<typeof ToolCallBlock>;

export const ToolResultBlock = z.object({
  kind: z.literal("tool_result"),
  id: z.string(), // matches tool_call id
  content: z.string(),
  is_error: z.boolean(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

export const Block = z.discriminatedUnion("kind", [
  UserTextBlock,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
]);
export type Block = z.infer<typeof Block>;
