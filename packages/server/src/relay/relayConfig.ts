import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 网络中继（消息级 LLM 桥）的配置层：
//   data/relay.json       管理员总开关（内存缓存，写时失效）
//   data/relay-users.json 用户 opt-in（用户名 → true；bootstrap 管理员不在
//                         users.json 里，所以独立成文件而不是 users 字段）
// 默认 enabled=false = 功能关闭（fail-closed）：任一条件不满足时引擎 env 不
// 注入桥 base_url，行为与中继功能不存在时完全一致。

const RelayConfigFile = z.object({
  enabled: z.boolean(),
  updated_at: z.string().optional(),
});
export type RelayConfig = z.infer<typeof RelayConfigFile>;

const DEFAULTS: RelayConfig = { enabled: false };

function relayFile(): string {
  return path.join(config.dataDir, "relay.json");
}

let cache: RelayConfig | null = null;

export function loadRelayConfig(): RelayConfig {
  if (cache) return cache;
  const parsed = RelayConfigFile.safeParse(readJson(relayFile()));
  cache = parsed.success ? parsed.data : DEFAULTS;
  return cache;
}

export function saveRelayConfig(next: { enabled: boolean }): RelayConfig {
  const full: RelayConfig = { ...next, updated_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(relayFile()), { recursive: true });
  fs.writeFileSync(relayFile(), JSON.stringify(full, null, 2));
  cache = full;
  return full;
}

// ---------- 用户 opt-in ----------

function optInFile(): string {
  return path.join(config.dataDir, "relay-users.json");
}

export function getRelayOptIn(username: string): boolean {
  const all = readJson(optInFile());
  return (
    all !== null && typeof all === "object" && !Array.isArray(all) &&
    (all as Record<string, unknown>)[username] === true
  );
}

export function setRelayOptIn(username: string, on: boolean): void {
  const all = (readJson(optInFile()) ?? {}) as Record<string, unknown>;
  if (on) all[username] = true;
  else delete all[username];
  fs.mkdirSync(path.dirname(optInFile()), { recursive: true });
  fs.writeFileSync(optInFile(), JSON.stringify(all, null, 2));
}

/** 全部 opt-in 用户名（服务启动时预建桥端口用）。 */
export function getRelayOptInUsernames(): string[] {
  const all = readJson(optInFile());
  if (all === null || typeof all !== "object" || Array.isArray(all)) return [];
  return Object.entries(all as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
