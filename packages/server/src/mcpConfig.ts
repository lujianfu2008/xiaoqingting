import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import type { McpServerDef } from "@blm/protocol";
import { McpServerDef as McpServerDefSchema, McpServerName } from "@blm/protocol";
import { config } from "./config.js";

// MCP 服务器配置：全局（data/mcp.json，管理员维护、可直接手改）+ 用户级
// （data/mcp-users.json，仅远程 http/sse，REST 管理）。与 llmConfig.ts 同构：
// 单文件按用户名分桶；headers 里可能存 token，文件权限 0600。
// 合并优先级：builtin < 全局 < 用户（同名时用户配置整体覆盖，可借此屏蔽全局）。

export class McpConfigError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// 与内置/代理 MCP 服务器（builtin/client/public）同名会覆盖引擎关键组件，禁止。
export const RESERVED_MCP_NAMES = new Set(["builtin", "client", "public"]);

function globalFile(): string {
  return path.join(config.dataDir, "mcp.json");
}

function userFile(): string {
  return path.join(config.dataDir, "mcp-users.json");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 手改的全局配置可能缺 type（SDK 约定 stdio 可省略；历史文件 url 默认 sse），
// 这里统一补全后再按协议校验；缺关键字段（stdio 无 command / 远程无 url）或
// 结构非法的条目静默丢弃（不出现在列表、不进引擎）。
function normalizeDef(raw: unknown): McpServerDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = { ...(raw as Record<string, unknown>) };
  if (typeof obj.type !== "string" || !["stdio", "http", "sse"].includes(obj.type)) {
    obj.type = obj.command ? "stdio" : "sse";
  }
  const parsed = McpServerDefSchema.safeParse(obj);
  if (!parsed.success) return null;
  const def = parsed.data;
  if (def.type === "stdio" && !def.command?.trim()) return null;
  if ((def.type === "http" || def.type === "sse") && !def.url?.trim()) return null;
  return def;
}

function normalizeMap(raw: unknown): Record<string, McpServerDef> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!McpServerName.safeParse(name).success) continue;
    const normalized = normalizeDef(def);
    if (normalized) out[name] = normalized;
  }
  return out;
}

export function loadGlobalServers(): Record<string, McpServerDef> {
  const parsed = readJson(globalFile()) as { mcpServers?: unknown } | null;
  return normalizeMap(parsed?.mcpServers);
}

export function saveGlobalServers(map: Record<string, McpServerDef>): void {
  fs.mkdirSync(path.dirname(globalFile()), { recursive: true });
  fs.writeFileSync(globalFile(), JSON.stringify({ mcpServers: map }, null, 2));
}

interface StoredUserMcp {
  servers: Record<string, McpServerDef>;
  updated_at: string;
}

function loadUserAll(): Record<string, StoredUserMcp> {
  const parsed = readJson(userFile());
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, StoredUserMcp>)
    : {};
}

function saveUserAll(all: Record<string, StoredUserMcp>): void {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function getUserServers(username: string): Record<string, McpServerDef> {
  return normalizeMap(loadUserAll()[username]?.servers);
}

export function setUserServer(username: string, name: string, def: McpServerDef): void {
  const all = loadUserAll();
  all[username] = {
    servers: { ...all[username]?.servers, [name]: def },
    updated_at: new Date().toISOString(),
  };
  saveUserAll(all);
}

export function deleteUserServer(username: string, name: string): boolean {
  const all = loadUserAll();
  const mine = all[username]?.servers;
  if (!mine || !(name in mine)) return false;
  delete mine[name];
  all[username] = { servers: mine, updated_at: new Date().toISOString() };
  saveUserAll(all);
  return true;
}

export interface MergedMcp {
  servers: Record<string, McpServerDef>;
  /** 被用户同名配置覆盖的全局服务器名。 */
  userOverrides: Set<string>;
}

/** 全局 + 用户配置合并后的有效视图（含 enabled=false 的条目，由构建方过滤）。 */
export function mergeMcpServers(username?: string): MergedMcp {
  const servers: Record<string, McpServerDef> = { ...loadGlobalServers() };
  const userOverrides = new Set<string>();
  if (username) {
    for (const [name, def] of Object.entries(getUserServers(username))) {
      if (name in servers) userOverrides.add(name);
      servers[name] = def;
    }
  }
  return { servers, userOverrides };
}

// ---------- SSRF 防护：用户级远程 URL 只允许公网 http/https ----------

// 127/8、10/8、192.168/16、169.254/16（云元数据）、0/8、CGNAT 100.64/10、
// 172.16/12；IPv6 另行判断。
const PRIVATE_V4_RE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

// relay（客户端出口中继）复用：CONNECT 目标与桌面端拨号前的私网检查。
export function isPrivateAddress(addr: string): boolean {
  if (addr.includes(":")) {
    const low = addr.toLowerCase();
    return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
  }
  return PRIVATE_V4_RE.some((re) => re.test(addr));
}

/**
 * 用户可配任意 URL 而服务端会真实发起连接，必须挡住内网/本机地址（SSRF）。
 * 域名会做一次 DNS 解析，解析结果的每个地址都过私网检查。
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpConfigError("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new McpConfigError("invalid_url");
  }
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new McpConfigError("private_url");
  }
  if (isPrivateAddress(host)) throw new McpConfigError("private_url");
  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new McpConfigError("unresolvable_host");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new McpConfigError("private_url");
  }
}

// ---------- 粘贴导入解析 ----------

/**
 * 接受 MCP 市场通用的粘贴格式：{"mcpServers":{...}} 或裸的 {名称: 定义}。
 * 返回原始映射；无法解析返回 null。
 */
export function parseImportedServers(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    obj.mcpServers &&
    typeof obj.mcpServers === "object" &&
    !Array.isArray(obj.mcpServers)
  ) {
    return obj.mcpServers as Record<string, unknown>;
  }
  return obj;
}

export { normalizeDef };
