import type { McpRegistryCard, McpRegistrySearchResponse } from "@blm/protocol";
import { McpServerName } from "@blm/protocol";
import { config } from "./config.js";
import { McpConfigError } from "./mcpConfig.js";

// 官方 MCP Registry（registry.modelcontextprotocol.io）搜索代理。
// 走服务端而非浏览器直连：绕开 CORS，也不暴露部署位置。这里只做读取与
// 规范化——安装动作仍走既有的 /api/mcp/* 写入端点（SSRF / stdio 限制照常生效）。

const FETCH_TIMEOUT_MS = 15_000;

// 原始条目里我们关心的字段（其余忽略）。字段名是上游 schema 定的 camelCase。
interface RawRemoteHeader {
  name?: unknown;
  value?: unknown; // 可能含 {placeholder} 凭证占位符
}
interface RawRemote {
  type?: unknown; // "streamable-http" | "sse" | ...
  url?: unknown;
  headers?: RawRemoteHeader[];
}
interface RawPackage {
  registryType?: unknown; // "npm" | "pypi" | "oci" | ...
  identifier?: unknown;
  version?: unknown;
  environmentVariables?: { name?: unknown; isRequired?: unknown }[];
}
interface RawServer {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  remotes?: RawRemote[] | null;
  packages?: RawPackage[] | null;
}

/** 规范名尾段 → 合法安装名："io.github/user/some-server" → "some-server"。 */
function deriveInstallName(registryName: string): string {
  const last = registryName.split("/").pop() ?? registryName;
  const cleaned = last
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return cleaned || "mcp-server";
}

function normalizeRemote(
  r: RawRemote,
): { type: "http" | "sse"; url: string; needs_auth?: boolean } | null {
  if (typeof r?.url !== "string" || !r.url) return null;
  const type = r.type === "sse" ? "sse" : r.type === "streamable-http" ? "http" : null;
  if (!type) return null;
  // header 值里的 {xxx} 是注册表要求的凭证占位符：不能原样安装，标记后
  // 由用户在编辑表单里补真实 token。
  const needsAuth = (r.headers ?? []).some(
    (h) => typeof h?.value === "string" && /\{[^}]+\}/.test(h.value),
  );
  return { type, url: r.url, needs_auth: needsAuth || undefined };
}

function normalizePackage(
  p: RawPackage,
): { registry_type: string; identifier: string; version?: string; env_required?: string[] } | null {
  if (typeof p?.identifier !== "string" || !p.identifier) return null;
  const registryType = typeof p.registryType === "string" ? p.registryType.toLowerCase() : "";
  if (registryType !== "npm" && registryType !== "pypi") return null;
  const envRequired = (p.environmentVariables ?? [])
    .filter((v) => v?.isRequired && typeof v.name === "string")
    .map((v) => v.name as string);
  return {
    registry_type: registryType,
    identifier: p.identifier,
    version: typeof p.version === "string" ? p.version : undefined,
    env_required: envRequired.length > 0 ? envRequired : undefined,
  };
}

function normalizeCard(raw: RawServer): McpRegistryCard | null {
  if (typeof raw?.name !== "string" || !raw.name) return null;
  const installName = deriveInstallName(raw.name);
  if (!McpServerName.safeParse(installName).success) return null;
  const remote = (raw.remotes ?? []).map(normalizeRemote).find(Boolean) ?? undefined;
  const pkg = (raw.packages ?? []).map(normalizePackage).find(Boolean) ?? undefined;
  if (!remote && !pkg) return null; // 既不能远程连也不能装的条目不出卡片
  const description = typeof raw.description === "string" ? raw.description : "";
  return {
    id: raw.name,
    install_name: installName,
    title: typeof raw.title === "string" && raw.title ? raw.title : undefined,
    description,
    version: typeof raw.version === "string" ? raw.version : undefined,
    remote: remote || undefined,
    pkg: pkg || undefined,
  };
}

export async function searchRegistry(
  query: string,
  limit: number,
  cursor?: string,
): Promise<McpRegistrySearchResponse> {
  const url = new URL("/v0/servers", config.mcpRegistryUrl);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new McpConfigError("registry_unreachable");
  }
  if (!res.ok) throw new McpConfigError("registry_unreachable");

  let body: { servers?: { server?: RawServer }[]; metadata?: { nextCursor?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new McpConfigError("registry_unreachable");
  }
  const servers = (body.servers ?? [])
    .map((entry) => normalizeCard(entry?.server ?? {}))
    .filter((c): c is McpRegistryCard => c !== null);
  const nextCursor = body.metadata?.nextCursor;
  return {
    servers,
    next_cursor: typeof nextCursor === "string" ? nextCursor : undefined,
  };
}
