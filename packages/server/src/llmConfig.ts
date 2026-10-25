import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LlmConfigInfo } from "@blm/protocol";
import { config } from "./config.js";

// Per-user LLM credentials (data/llm-configs.json), keyed by username.
// API keys are encrypted at rest with AES-256-GCM and never leave the server:
// the REST layer only ever sees `describeLlmConfig()` output (tail hint only).

interface StoredLlmConfig {
  api_key_enc?: string;
  base_url?: string;
  model?: string;
  updated_at: string;
}

export interface ResolvedLlmConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
}

export interface LlmConfigPatch {
  api_key?: string;
  base_url?: string;
  model?: string;
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
  return { api_key: api_key ?? undefined, base_url, model };
}

/** Client-safe view: no plaintext key, only the last 4 characters. */
export function describeLlmConfig(username: string): LlmConfigInfo {
  const stored = loadAll()[username];
  if (!stored) return { configured: false };
  const api_key = stored.api_key_enc ? decrypt(stored.api_key_enc) : null;
  const base_url = stored.base_url?.trim() || undefined;
  const model = stored.model?.trim() || undefined;
  if (!api_key && !base_url && !model) return { configured: false };
  return {
    configured: true,
    base_url,
    model,
    api_key_hint: api_key ? api_key.slice(-4) : undefined,
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
    updated_at: new Date().toISOString(),
  };
  const apiKey = patch.api_key?.trim();
  if (apiKey) next.api_key_enc = encrypt(apiKey);
  if (patch.base_url !== undefined) next.base_url = patch.base_url.trim() || undefined;
  if (patch.model !== undefined) next.model = patch.model.trim() || undefined;
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
