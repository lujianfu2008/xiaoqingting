import type { SkillRegistryCard, SkillRegistrySearchResponse } from "@blm/protocol";
import { SkillName } from "@blm/protocol";
import { config } from "./config.js";
import { SkillsConfigError } from "./skillsConfig.js";

// 专家市场：SKILLS_REGISTRY_URL 指向一份 JSON 清单
// {"skills":[{"name","title","description","url","version"}]}。
// 与 MCP Registry 代理同构：服务端拉取（绕 CORS、不暴露部署位置）、缓存 5
// 分钟、按关键词过滤后返回卡片。安装动作仍走 /api/skills/* 写入端点（下载时
// 照常过 SSRF 过滤），这里只做读取与规范化。

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;

interface RawCard {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  url?: unknown;
}

let cache: { at: number; cards: SkillRegistryCard[] } | null = null;

function normalizeCard(raw: RawCard): SkillRegistryCard | null {
  if (typeof raw?.name !== "string" || typeof raw?.url !== "string") return null;
  if (!/^https?:\/\//i.test(raw.url)) return null; // 完整 SSRF 校验在安装时做
  if (!SkillName.safeParse(raw.name).success) return null;
  return {
    id: raw.name,
    install_name: raw.name,
    title: typeof raw.title === "string" && raw.title ? raw.title : undefined,
    description: typeof raw.description === "string" ? raw.description : "",
    version: typeof raw.version === "string" ? raw.version : undefined,
    url: raw.url,
  };
}

async function loadManifest(): Promise<SkillRegistryCard[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cards;
  let res: Response;
  try {
    res = await fetch(config.skillsRegistryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new SkillsConfigError("registry_unreachable");
  }
  if (!res.ok) throw new SkillsConfigError("registry_unreachable");
  let body: { skills?: RawCard[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new SkillsConfigError("registry_unreachable");
  }
  const cards = (body.skills ?? [])
    .map(normalizeCard)
    .filter((c): c is SkillRegistryCard => c !== null);
  cache = { at: Date.now(), cards };
  return cards;
}

/** 关键词过滤（匹配名称/标题/描述，大小写不敏感）。 */
export async function searchSkillRegistry(
  query: string,
  limit: number,
): Promise<SkillRegistrySearchResponse> {
  const q = query.toLowerCase();
  const all = await loadManifest();
  const skills = all
    .filter(
      (c) =>
        c.install_name.toLowerCase().includes(q) ||
        (c.title ?? "").toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    )
    .slice(0, limit);
  return { skills };
}
