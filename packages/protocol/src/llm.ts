import { z } from "zod";

// ---------- Per-user LLM configuration ----------

// 上游网关的 API 协议：anthropic = 引擎直连（默认）；openai = 服务端
// 翻译层把引擎的 Anthropic 请求转成 OpenAI chat/completions（国内网关多为
// 这种）。
export const LlmProtocol = z.enum(["anthropic", "openai"]);
export type LlmProtocol = z.infer<typeof LlmProtocol>;

// 一条个人大模型配置。永不含明文 Key——只有尾号提示。
export const LlmProfileInfo = z.object({
  id: z.string(),
  name: z.string(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  protocol: LlmProtocol.optional(),
  api_key_hint: z.string().optional(),
  // 停用的配置不参与选型（优先级顺序仍保留）。
  enabled: z.boolean(),
});
export type LlmProfileInfo = z.infer<typeof LlmProfileInfo>;

// 多配置共用的调用策略。
export const LlmSettingsInfo = z.object({
  // 单次上游请求超时（毫秒）：等不到响应头、或流式响应中途停摆超过此时长
  // 都判超时。
  timeout_ms: z.number().int().min(5_000).max(600_000),
  // 超时/网络错误/5xx/429 时对同一配置自动重试的次数（0 = 不重试）。
  retries: z.number().int().min(0).max(5),
  // 自动模型选择：当前配置重试耗尽仍失败时，自动切换下一个启用的配置。
  auto_select: z.boolean(),
});
export type LlmSettingsInfo = z.infer<typeof LlmSettingsInfo>;

export const LlmConfigInfo = z.object({
  // 至少一条配置带有效内容（Key/Base URL/模型名任一）时为 true。
  configured: z.boolean(),
  // 按优先级排序（数组序 = 择优顺序，首个启用者优先生效）。
  profiles: z.array(LlmProfileInfo),
  settings: LlmSettingsInfo,
  // 每用户费用上限（美元，0 = 不限）；absent = 跟随 global_budget_usd。
  max_budget_usd: z.number().min(0).optional(),
  // 服务器全局默认（MAX_BUDGET_USD，0 = 不限）——UI 提示用。
  global_budget_usd: z.number().optional(),
});
export type LlmConfigInfo = z.infer<typeof LlmConfigInfo>;

export const UpdateLlmProfileRequest = z.object({
  // absent = 新建（排到列表末尾）；有 id = 编辑。
  id: z.string().optional(),
  name: z.string().min(1).max(50),
  // 空串/absent = 保持已存 Key 不变。
  api_key: z.string().max(400).optional(),
  // 空串 = 清除该字段；absent = 保持不变。
  base_url: z
    .union([
      z.literal(""),
      z
        .string()
        .url()
        .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
          message: "base_url 只支持 http/https",
        }),
    ])
    .optional(),
  model: z.string().max(100).optional(),
  protocol: LlmProtocol.optional(),
});
export type UpdateLlmProfileRequest = z.infer<typeof UpdateLlmProfileRequest>;

export const LlmProfileEnabledRequest = z.object({
  enabled: z.boolean(),
});
export type LlmProfileEnabledRequest = z.infer<typeof LlmProfileEnabledRequest>;

export const LlmReorderRequest = z.object({
  // 完整的配置 id 序列（必须与现有集合一致）。
  ids: z.array(z.string()).min(1).max(8),
});
export type LlmReorderRequest = z.infer<typeof LlmReorderRequest>;

export const LlmSettingsPatch = z.object({
  timeout_ms: z.number().int().min(5_000).max(600_000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  auto_select: z.boolean().optional(),
  // 每用户费用上限（美元）；null = 清除个人设置（跟随全局）。
  max_budget_usd: z.number().min(0).max(100000).nullable().optional(),
});
export type LlmSettingsPatch = z.infer<typeof LlmSettingsPatch>;
