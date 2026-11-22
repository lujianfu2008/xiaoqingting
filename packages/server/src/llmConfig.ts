import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  LlmConfigInfo,
  LlmProfileInfo,
  LlmProtocol,
  LlmSettingsInfo,
  LlmSettingsPatch,
  UpdateLlmProfileRequest,
} from "@blm/protocol";
import { config } from "./config.js";

// Per-user LLM credentials (data/llm-configs.json), keyed by username.
// 每用户可配置多条大模型（profiles，数组序 = 择优优先级），另有一组调用
// 策略（settings：超时/重试/自动模型选择）。API keys are encrypted at rest
// with AES-256-GCM and never leave the server: the REST layer only ever sees
// describeLlmConfig() output (tail hint only).
//
// 旧版单条扁平结构（api_key_enc/base_url/model/protocol 直接挂在用户条目上）
// 在 loadAll 时自动迁移为第一条启用配置。

const MAX_PROFILES = 8;

export const LLM_DEFAULT_TIMEOUT_MS = 90_000;
export const LLM_DEFAULT_RETRIES = 2;
export const LLM_DEFAULT_AUTO_SELECT = true;

interface StoredProfile {
  id: string;
  name: string;
  api_key_enc?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
  enabled: boolean;
}

interface StoredSettings {
  timeout_ms?: number;
  retries?: number;
  auto_select?: boolean;
}

interface StoredLlmConfig {
  profiles?: StoredProfile[];
  settings?: StoredSettings;
  // 每用户费用上限（美元，0 = 不限）；absent = 跟随全局 MAX_BUDGET_USD。
  max_budget_usd?: number;
  updated_at: string;
  // ---- 以下为旧版扁平字段：仅迁移前存在，读入即折叠进 profiles ----
  api_key_enc?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
}

/** 解密后的单条配置（服务端内部用，绝不出 REST）。 */
export interface ResolvedProfile {
  id: string;
  name: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  protocol?: LlmProtocol;
}

function configsFile(): string {
  return path.join(config.dataDir, "llm-configs.json");
}

function newProfileId(): string {
  return `p_${crypto.randomBytes(6).toString("hex")}`;
}

/** 一条配置是否没有任何有效内容（Key/Base URL/模型名全空）。 */
function isEmptyProfile(p: StoredProfile): boolean {
  return !p.api_key_enc && !p.base_url?.trim() && !p.model?.trim();
}

function loadAll(): Record<string, StoredLlmConfig> {
  let all: Record<string, StoredLlmConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configsFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      all = parsed as Record<string, StoredLlmConfig>;
    }
  } catch {
    return {};
  }
  // 旧版扁平结构迁移：折叠成第一条启用配置。立即落盘一次（幂等）。
  let migrated = false;
  for (const [username, stored] of Object.entries(all)) {
    if (Array.isArray(stored.profiles)) continue;
    const legacy: StoredProfile | null =
      stored.api_key_enc || stored.base_url?.trim() || stored.model?.trim()
        ? {
            id: newProfileId(),
            name: "配置 1",
            api_key_enc: stored.api_key_enc,
            base_url: stored.base_url,
            model: stored.model,
            protocol: stored.protocol,
            enabled: true,
          }
        : null;
    stored.profiles = legacy ? [legacy] : [];
    delete stored.api_key_enc;
    delete stored.base_url;
    delete stored.model;
    delete stored.protocol;
    migrated = true;
  }
  if (migrated) saveAll(all);
  return all;
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

function resolveStored(p: StoredProfile): ResolvedProfile {
  const api_key = p.api_key_enc ? decrypt(p.api_key_enc) : null;
  return {
    id: p.id,
    name: p.name,
    api_key: api_key ?? undefined,
    base_url: p.base_url?.trim() || undefined,
    model: p.model?.trim() || undefined,
    protocol: p.protocol,
  };
}

/** 按优先级返回全部启用且有有效内容的配置（择优顺序）。 */
export function getEnabledLlmProfiles(username: string): ResolvedProfile[] {
  return (loadAll()[username]?.profiles ?? [])
    .filter((p) => p.enabled && !isEmptyProfile(p))
    .map(resolveStored);
}

/** 当前生效配置：优先级最高的启用项；没有则 null（用服务器默认）。 */
export function getActiveLlmProfile(username: string): ResolvedProfile | null {
  return getEnabledLlmProfiles(username)[0] ?? null;
}

/** 兼容别名：会话 env 注入、市场翻译等只关心「当前生效的那条」。 */
export function getUserLlmConfig(username: string): ResolvedProfile | null {
  return getActiveLlmProfile(username);
}

/** 调用策略（带默认值与钳制）。 */
export function getUserLlmSettings(username: string): LlmSettingsInfo {
  const s = loadAll()[username]?.settings ?? {};
  return {
    timeout_ms: clampNum(s.timeout_ms, 5_000, 600_000, LLM_DEFAULT_TIMEOUT_MS),
    retries: clampNum(s.retries, 0, 5, LLM_DEFAULT_RETRIES),
    auto_select: s.auto_select ?? LLM_DEFAULT_AUTO_SELECT,
  };
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.floor(v)))
    : fallback;
}

/**
 * 引擎侧 API 超时预算：要容得下代理层「重试 × 候选数」的完整失败链，
 * 否则引擎先超时打断，自动切换还没轮完。上限 30 分钟（仅为兜底，代理层
 * 自己的超时才是准的）。
 */
export function engineApiTimeoutBudgetMs(username: string): number {
  const s = getUserLlmSettings(username);
  const candidates = Math.max(1, getEnabledLlmProfiles(username).length);
  const budget = s.timeout_ms * (s.retries + 1) * candidates + 60_000;
  return Math.min(Math.max(budget, s.timeout_ms), 1_800_000);
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
  const all = loadAll();
  const stored = all[username];
  const profiles: LlmProfileInfo[] = (stored?.profiles ?? []).map((p) => {
    const api_key = p.api_key_enc ? decrypt(p.api_key_enc) : null;
    return {
      id: p.id,
      name: p.name,
      base_url: p.base_url?.trim() || undefined,
      model: p.model?.trim() || undefined,
      protocol: p.protocol,
      api_key_hint: api_key ? api_key.slice(-4) : undefined,
      enabled: p.enabled,
    };
  });
  return {
    configured: profiles.some((p) => p.enabled && (p.api_key_hint || p.base_url || p.model)),
    profiles,
    settings: getUserLlmSettings(username),
    ...(stored?.max_budget_usd !== undefined ? { max_budget_usd: stored.max_budget_usd } : {}),
    global_budget_usd: config.maxBudgetUsd,
  };
}

function mutate(
  username: string,
  fn: (entry: StoredLlmConfig) => void,
): LlmConfigInfo {
  const all = loadAll();
  const entry: StoredLlmConfig = all[username] ?? {
    profiles: [],
    updated_at: "",
  };
  if (!Array.isArray(entry.profiles)) entry.profiles = [];
  fn(entry);
  entry.updated_at = new Date().toISOString();
  all[username] = entry;
  saveAll(all);
  return describeLlmConfig(username);
}

/** 新建/编辑一条配置。空 api_key = 保持已存 Key；空 base_url/model = 清除该字段。 */
export function upsertLlmProfile(
  username: string,
  req: UpdateLlmProfileRequest,
): LlmConfigInfo {
  return mutate(username, (entry) => {
    const profiles = entry.profiles ?? [];
    const base = req.base_url === undefined ? undefined : req.base_url.trim() || "";
    const model = req.model === undefined ? undefined : req.model.trim() || "";
    const protocol =
      req.protocol === undefined ? undefined : req.protocol === "openai" ? ("openai" as const) : undefined;
    if (req.id) {
      const p = profiles.find((x) => x.id === req.id);
      if (!p) throw new Error("profile_not_found");
      p.name = req.name.trim();
      const apiKey = req.api_key?.trim();
      if (apiKey) p.api_key_enc = encrypt(apiKey);
      if (base !== undefined) p.base_url = base || undefined;
      if (model !== undefined) p.model = model || undefined;
      if (protocol !== undefined) p.protocol = protocol;
    } else {
      if (profiles.length >= MAX_PROFILES) throw new Error("too_many_profiles");
      // 新建的配置要有内容（Key/Base URL/模型名任一），否则纯噪音。
      if (!req.api_key?.trim() && !base && !model) throw new Error("empty_profile");
      profiles.push({
        id: newProfileId(),
        name: req.name.trim(),
        api_key_enc: req.api_key?.trim() ? encrypt(req.api_key.trim()) : undefined,
        base_url: base || undefined,
        model: model || undefined,
        protocol,
        enabled: true,
      });
    }
  });
}

export function deleteLlmProfile(username: string, id: string): LlmConfigInfo {
  return mutate(username, (entry) => {
    entry.profiles = (entry.profiles ?? []).filter((p) => p.id !== id);
  });
}

export function setLlmProfileEnabled(
  username: string,
  id: string,
  enabled: boolean,
): LlmConfigInfo {
  return mutate(username, (entry) => {
    const p = (entry.profiles ?? []).find((x) => x.id === id);
    if (!p) throw new Error("profile_not_found");
    p.enabled = enabled;
  });
}

/** 重排优先级（数组序 = 择优顺序）。必须给全现有 id 集合。 */
export function reorderLlmProfiles(username: string, ids: string[]): LlmConfigInfo {
  return mutate(username, (entry) => {
    const profiles = entry.profiles ?? [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    if (ids.length !== profiles.length || ids.some((id) => !byId.has(id))) {
      throw new Error("bad_order");
    }
    entry.profiles = ids.map((id) => byId.get(id)!);
  });
}

export function updateLlmSettings(username: string, patch: LlmSettingsPatch): LlmConfigInfo {
  return mutate(username, (entry) => {
    const cur = getUserLlmSettings(username);
    entry.settings = {
      timeout_ms:
        patch.timeout_ms !== undefined
          ? clampNum(patch.timeout_ms, 5_000, 600_000, cur.timeout_ms)
          : cur.timeout_ms === LLM_DEFAULT_TIMEOUT_MS
            ? undefined
            : cur.timeout_ms,
      retries:
        patch.retries !== undefined
          ? clampNum(patch.retries, 0, 5, cur.retries)
          : cur.retries === LLM_DEFAULT_RETRIES
            ? undefined
            : cur.retries,
      auto_select:
        patch.auto_select !== undefined
          ? patch.auto_select
          : cur.auto_select === LLM_DEFAULT_AUTO_SELECT
            ? undefined
            : cur.auto_select,
    };
    // 费用上限跟策略同面板保存：null = 清除个人设置（跟随全局）。
    if (patch.max_budget_usd !== undefined) {
      entry.max_budget_usd =
        patch.max_budget_usd === null ? undefined : patch.max_budget_usd;
    }
  });
}

/** 清空全部个人配置（含 Key/策略/费用上限），回到服务器默认。 */
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

// Role models are SDK aliases ("sonnet"…); a deployment may remap them to
// any backend via ANTHROPIC_DEFAULT_SONNET_MODEL etc. Vision must be
// judged on the resolved name, not the alias.
function resolveEngineModel(model: string): string {
  const alias = model.trim().toUpperCase();
  if (alias === "SONNET" || alias === "OPUS" || alias === "HAIKU") {
    return process.env[`ANTHROPIC_DEFAULT_${alias}_MODEL`]?.trim() || model;
  }
  return model;
}

/**
 * Whether the engine model can view images directly. No model given → the
 * role default model, which has vision.
 */
export function modelSupportsVision(model?: string): boolean {
  if (!model) return true;
  return VISION_MODEL_RE.test(resolveEngineModel(model));
}
