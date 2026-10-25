import { z } from "zod";

// ---------- Per-user LLM configuration ----------

// Never contains the plaintext API key — only a tail hint.
export const LlmConfigInfo = z.object({
  configured: z.boolean(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  api_key_hint: z.string().optional(),
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
});
export type UpdateLlmConfigRequest = z.infer<typeof UpdateLlmConfigRequest>;
