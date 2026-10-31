import { z } from "zod";

// ---------- Per-user LLM configuration ----------

// 上游网关的 API 协议：anthropic = Claude 引擎直连（默认）；openai = 服务端
// 翻译层把引擎的 Anthropic 请求转成 OpenAI chat/completions（国内网关多为
// 这种）。
export const LlmProtocol = z.enum(["anthropic", "openai"]);
export type LlmProtocol = z.infer<typeof LlmProtocol>;

// Never contains the plaintext API key — only a tail hint.
export const LlmConfigInfo = z.object({
  configured: z.boolean(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  protocol: LlmProtocol.optional(),
  api_key_hint: z.string().optional(),
  // 每用户费用上限（美元，0 = 不限）；absent = 跟随 global_budget_usd。
  max_budget_usd: z.number().min(0).optional(),
  // 服务器全局默认（MAX_BUDGET_USD，0 = 不限）——UI 提示用。
  global_budget_usd: z.number().optional(),
});
export type LlmConfigInfo = z.infer<typeof LlmConfigInfo>;

export const UpdateLlmConfigRequest = z.object({
  // Empty string means "keep the stored key unchanged".
  api_key: z.string().max(400).optional(),
  base_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "base_url 只支持 http/https",
    })
    .optional(),
  model: z.string().max(100).optional(),
  protocol: LlmProtocol.optional(),
  // null = 清除个人设置（跟随全局）；absent = 保持不变。
  max_budget_usd: z.number().min(0).max(100000).nullable().optional(),
});
export type UpdateLlmConfigRequest = z.infer<typeof UpdateLlmConfigRequest>;
