import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LlmConfigInfo, LlmProtocol } from "@blm/protocol";
import { config } from "./config.js";

// Per-user LLM credentials (data/llm-configs.json), keyed by username.
// API keys are encrypted at rest with AES-256-GCM and never leave the server:
// the REST layer only ever sees `describeLlmConfig()` output (tail hint only).

interface StoredLlmConfig {
  api_key_enc?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
  // 每用户费用上限（美元，0 = 不限）；absent = 跟随全局 MAX_BUDGET_USD。
  max_budget_usd?: number;
  updated_at: string;
}

export interface ResolvedLlmConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
}

export interface LlmConfigPatch {
  api_key?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
  // null = 清除个人设置（跟随全局）；absent = 保持不变。
  max_budget_usd?: number | null;
}

function configsFile(): string {
  return path.join(config.dataDir, "llm-configs.json");
}

function loadAll(): Record<string, StoredLlmConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configsFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, StoredLlmConfig>)
      : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, StoredLlmConfig>): void {
  fs.mkdirSync(path.dirname(configsFile()), { recursive: true });
  fs.writeFileSync(configsFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

function key(): Buffer {
  return crypto.scryptSync(config.credentialSecret, "blm-llm-config", 32);
}

/** Encrypt to `iv.tag.cipher`, each base64. */
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong CREDENTIAL_SECRET or corrupted entry — treat as unconfigured.
    return null;
  }
}

/** Decrypted config for engine injection. Server-side only — never send this out. */
export function getUserLlmConfig(username: string): ResolvedLlmConfig | null {
  const stored = loadAll()[username];
  if (!stored) return null;
  const api_key = stored.api_key_enc ? decrypt(stored.api_key_enc) : null;
  const base_url = stored.base_url?.trim() || undefined;
  const model = stored.model?.trim() || undefined;
  if (!api_key && !base_url && !model) return null;
  return { api_key: api_key ?? undefined, base_url, model, protocol: stored.protocol };
}

/**
 * 每用户费用上限：undefined = 未设置（跟随全局 MAX_BUDGET_USD）；0 = 不限制；
 * >0 = 上限美元数。与凭证无关——只用服务器默认模型的用户也能设自己的上限。
 */
export function getUserMaxBudgetUsd(username: string): number | undefined {
  const v = loadAll()[username]?.max_budget_usd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Client-safe view: no plaintext key, only the last 4 characters. */
export function describeLlmConfig(username: string): LlmConfigInfo {
  const stored = loadAll()[username];
  if (!stored) return { configured: false, global_budget_usd: config.maxBudgetUsd };
  const api_key = stored.api_key_enc ? decrypt(stored.api_key_enc) : null;
  const base_url = stored.base_url?.trim() || undefined;
  const model = stored.model?.trim() || undefined;
  if (!api_key && !base_url && !model) {
    return {
      configured: false,
      global_budget_usd: config.maxBudgetUsd,
      ...(stored.max_budget_usd !== undefined ? { max_budget_usd: stored.max_budget_usd } : {}),
    };
  }
  return {
    configured: true,
    base_url,
    model,
    protocol: stored.protocol,
    api_key_hint: api_key ? api_key.slice(-4) : undefined,
    ...(stored.max_budget_usd !== undefined ? { max_budget_usd: stored.max_budget_usd } : {}),
    global_budget_usd: config.maxBudgetUsd,
  };
}

/**
 * Upsert a config. An empty/absent `api_key` keeps the stored key unchanged;
 * an empty `base_url` / `model` clears that field.
 */
export function setUserLlmConfig(
  username: string,
  patch: LlmConfigPatch,
): LlmConfigInfo {
  const all = loadAll();
  const prev = all[username];
  const next: StoredLlmConfig = {
    api_key_enc: prev?.api_key_enc,
    base_url: prev?.base_url,
    model: prev?.model,
    protocol: prev?.protocol,
    max_budget_usd: prev?.max_budget_usd,
    updated_at: new Date().toISOString(),
  };
  const apiKey = patch.api_key?.trim();
  if (apiKey) next.api_key_enc = encrypt(apiKey);
  if (patch.base_url !== undefined) next.base_url = patch.base_url.trim() || undefined;
  if (patch.model !== undefined) next.model = patch.model.trim() || undefined;
  if (patch.max_budget_usd !== undefined) {
    // null = 清除个人设置（跟随全局）；数字原样存（0 = 不限）。
    next.max_budget_usd = patch.max_budget_usd === null ? undefined : patch.max_budget_usd;
  }
  if (patch.protocol !== undefined) {
    // "anthropic" 是缺省行为，落盘时归一成 undefined，老配置不受影响。
    next.protocol = patch.protocol === "openai" ? "openai" : undefined;
  }
  all[username] = next;
  saveAll(all);
  return describeLlmConfig(username);
}

export function clearUserLlmConfig(username: string): void {
  const all = loadAll();
  if (!(username in all)) return;
  delete all[username];
  saveAll(all);
}

// Models known to accept image input. Conservative on purpose: anything
// unrecognized (new GLM text models etc.) falls back to OCR for attachments.
const VISION_MODEL_RE =
  /claude|sonnet|opus|haiku|glm-[.\d]*v|gpt-4o|gpt-5|gemini|qwen[.\d]*vl|pixtral|doubao.*vision/i;

// Role models are SDK aliases ("sonnet"…); a deployment may remap them to a
// non-Claude backend (ANTHROPIC_DEFAULT_SONNET_MODEL=GLM-…-Flash etc.). Vision
// must be judged on the resolved name, not the alias.
function resolveEngineModel(model: string): string {
  const alias = model.trim().toUpperCase();
  if (alias === "SONNET" || alias === "OPUS" || alias === "HAIKU") {
    return process.env[`ANTHROPIC_DEFAULT_${alias}_MODEL`]?.trim() || model;
  }
  return model;
}

/**
 * Whether the engine model can view images directly. No model given → the
 * role default (Claude Sonnet) which has vision.
 */
export function modelSupportsVision(model?: string): boolean {
  if (!model) return true;
  return VISION_MODEL_RE.test(resolveEngineModel(model));
}
