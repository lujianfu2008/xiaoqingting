import type { SkillRegistryCard, SkillRegistrySearchResponse } from "@blm/protocol";
import { SkillName } from "@blm/protocol";
import { config } from "./config.js";
import { readFrontmatterField, SkillsConfigError } from "./skillsConfig.js";

// 专家市场：SKILLS_REGISTRY_URL 两种形态——
// - "official"：官方技能库目录（官方仓库 .claude-plugin/marketplace.json，
//   官方钦定的机器可读清单）展开成逐技能卡片。官方没有 MCP Registry 那样的
//   搜索 API，仓库清单就是目录本身；本产品只装纯 SKILL.md，官方一半技能是
//   「SKILL.md + scripts/ 整包」，剥包即残，故带收录过滤。
// - 其他值：直接指向一份 JSON 清单 {"skills":[{"name","title","description",
//   "url","version"}]}。
// 与 MCP Registry 代理同构：服务端拉取（绕 CORS、不暴露部署位置）、缓存 5
// 分钟、按关键词过滤后返回卡片。安装动作仍走 /api/skills/* 写入端点（下载时
// 照常过 SSRF 过滤），这里只做读取与规范化。卡片描述过品牌词清洗——市场
// 是界面文案面，vendor 词不外露。

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;

// ---------- 官方技能库模式 ----------

const OFFICIAL_RAW_BASE =
  "https://raw.githubusercontent.com/anthropics/skills/main";

/** 排除名单：脚本/模板整包（只装 SKILL.md 会残缺）与 vendor 专项
 *  （描述即品牌词，不进界面）。名单外的新技能默认放行。 */
const OFFICIAL_EXCLUDED = new Set([
  // document-skills：全部依赖打包的 python 脚本
  "docx",
  "pdf",
  "pptx",
  "xlsx",
  // 工具脚本包
  "mcp-builder",
  "slack-gif-creator",
  "web-artifacts-builder",
  "webapp-testing",
  // vendor 专项（内容即品牌宣传/文档）
  "academy-guide",
  "brand-guidelines",
  "claude-api",
]);

/** 收录技能的中文文案与检索词：官方目录全英文，中文用户搜不到也读不懂；
 *  这里按技能给中文标题/描述（市场卡片直接展示）与中文关键词（进检索，
 *  英文 frontmatter 描述与名字仍在检索文本里，英文查询不受影响）。 */
const OFFICIAL_ZH: Record<string, { title: string; desc: string; kw: string[] }> = {
  "algorithmic-art": {
    title: "算法艺术",
    desc: "用 p5.js 代码生成算法艺术（流场、粒子系统等），参数可调、可交互。",
    kw: ["生成艺术", "艺术", "作画", "画画", "粒子", "生成图形"],
  },
  "canvas-design": {
    title: "平面设计",
    desc: "按设计哲学创作海报与视觉作品，输出 PNG/PDF。",
    kw: ["海报", "设计", "平面设计", "视觉", "做图", "宣传图"],
  },
  "doc-coauthoring": {
    title: "文档共创",
    desc: "结构化流程协同写文档/提案/技术方案：收集上下文 → 迭代打磨 → 读者验证。",
    kw: ["写文档", "文档", "方案", "提案", "协作写作", "技术文档"],
  },
  "frontend-design": {
    title: "前端设计",
    desc: "产出有质感的前端界面：布局、配色、字体与组件的审美指导。",
    kw: ["前端", "界面", "UI", "网页", "页面", "美观"],
  },
  "internal-comms": {
    title: "内部沟通",
    desc: "按团队常用格式写内部沟通：周报、简报、FAQ、事件通报、项目进展。",
    kw: ["周报", "汇报", "简报", "通讯", "内部沟通", "通报", "进展"],
  },
  "skill-creator": {
    title: "技能创作",
    desc: "创建新技能、优化现有技能的描述与触发准确度，可跑评测验证。",
    kw: ["创建技能", "写技能", "做技能", "技能优化", "评测"],
  },
  "theme-factory": {
    title: "主题工厂",
    desc: "给幻灯片/文档/网页等产物套主题：多套预设配色字体，也可现场生成新主题。",
    kw: ["主题", "配色", "美化", "风格", "换肤"],
  },
  "discernment-nudge": {
    title: "审辨追问",
    desc: "重要回答或草案完成后自动追加 2-3 个追问，帮你核查事实、推理与遗漏。",
    kw: ["追问", "审辨", "核查", "批判性思考", "复核"],
  },
};

/** 官方收录技能的中文文案（已安装列表 lang=zh 复用；市场与列表文案同源）。 */
export function zhCardFor(name: string): { title: string; desc: string } | null {
  const zh = OFFICIAL_ZH[name];
  return zh ? { title: zh.title, desc: zh.desc } : null;
}

/** 官方仓库 raw 资源 URL（配置了代理前缀则套上，本机直连 GitHub 极慢）。 */
function officialRawUrl(repoPath: string): string {
  const u = `${OFFICIAL_RAW_BASE}/${repoPath.replace(/^\.\//, "")}`;
  return config.skillsRegistryGhProxy ? `${config.skillsRegistryGhProxy}/${u}` : u;
}

/** 官方源拉取：配置了镜像前缀先走镜像，网络错或非 2xx 剥前缀直连原站兜底
 *  （免费镜像抖动频繁，直连慢但通常可达）；无前缀就只试一次。失败 throw。 */
async function fetchOfficial(url: string, accept: string): Promise<Response> {
  const attempt = (u: string): Promise<Response> =>
    fetch(u, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: accept },
    });
  try {
    const res = await attempt(url);
    if (res.ok) return res;
  } catch {
    // fall through to direct
  }
  const prefix = config.skillsRegistryGhProxy;
  const direct =
    prefix && url.startsWith(`${prefix}/`) ? url.slice(prefix.length + 1) : null;
  if (!direct) throw new Error("official fetch failed");
  const res = await attempt(direct);
  if (!res.ok) throw new Error(String(res.status));
  return res;
}

/** 卡片文案洗品牌词（市场卡是界面文案；改动保守，只动词不动句）。 */
function scrubCardText(text: string): string {
  return text
    .replace(/\bClaude's\b/g, "the assistant's")
    .replace(/\bClaude\b/g, "the assistant")
    .replace(/\bAnthropic's\b/g, "the vendor's")
    .replace(/\bAnthropic\b/g, "the vendor");
}

async function loadOfficialEntries(): Promise<CatalogEntry[]> {
  let manifest: {
    plugins?: { skills?: string[]; description?: string }[];
  };
  try {
    const res = await fetchOfficial(
      officialRawUrl(".claude-plugin/marketplace.json"),
      "application/json",
    );
    manifest = (await res.json()) as typeof manifest;
  } catch {
    throw new SkillsConfigError("registry_unreachable");
  }
  // 展开插件分组 → 逐技能路径（dedupe）。
  const seen = new Set<string>();
  const entries: { name: string; fallbackDesc: string }[] = [];
  for (const plugin of manifest.plugins ?? []) {
    for (const p of plugin.skills ?? []) {
      const m = /^\.?\/?skills\/([A-Za-z0-9][\w-]*)$/.exec(p);
      if (!m) continue;
      const name = m[1];
      if (OFFICIAL_EXCLUDED.has(name) || seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, fallbackDesc: plugin.description ?? "" });
    }
  }
  // 并行取各 SKILL.md 的 frontmatter（name/description 真值），单卡失败
  // 降级用分组描述，不拖垮整个清单。
  const settled = await Promise.allSettled(
    entries.map(async (e) => {
      const res = await fetchOfficial(
        officialRawUrl(`skills/${e.name}/SKILL.md`),
        "text/plain",
      );
      return res.text();
    }),
  );
  const catalog: CatalogEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const r = settled[i];
    const md = r.status === "fulfilled" ? r.value : "";
    const enDesc =
      scrubCardText(readFrontmatterField(md, "description") ?? e.fallbackDesc);
    const zh = OFFICIAL_ZH[e.name];
    const url = officialRawUrl(`skills/${e.name}/SKILL.md`);
    // 与通用清单同一条准入：名字合法、url 公网（这里 url 由本函数构造，必过）。
    if (!SkillName.safeParse(e.name).success) continue;
    const card: SkillRegistryCard = {
      id: e.name,
      install_name: e.name,
      ...(zh ? { title: zh.title } : {}),
      description: zh ? zh.desc : enDesc,
      url,
    };
    // 检索文本 = 名字 + 英文描述 + 中文标题/描述/关键词：中英文查询都命中。
    catalog.push(entryOf(card, [enDesc, ...(zh?.kw ?? [])], enDesc));
  }
  return catalog;
}

interface RawCard {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  url?: unknown;
}

/** 目录条目：卡片 + 检索文本（中文搜索靠额外关键词并进检索文本实现）
 *  + 英文原描述（lang=en 显示用；official 模式卡片描述已是中文）。 */
interface CatalogEntry {
  card: SkillRegistryCard;
  searchText: string;
  enDesc: string;
}

let cache: { at: number; entries: CatalogEntry[] } | null = null;

function entryOf(
  card: SkillRegistryCard,
  extra: string[] = [],
  enDesc?: string,
): CatalogEntry {
  return {
    card,
    searchText: [card.install_name, card.title ?? "", card.description, ...extra]
      .join(" ")
      .toLowerCase(),
    enDesc: enDesc ?? card.description,
  };
}

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

async function loadManifest(): Promise<CatalogEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  let entries: CatalogEntry[];
  if (config.skillsRegistryUrl === "official") {
    entries = await loadOfficialEntries();
  } else {
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
    entries = (body.skills ?? [])
      .map(normalizeCard)
      .filter((c): c is SkillRegistryCard => c !== null)
      .map((c) => entryOf(c));
  }
  cache = { at: Date.now(), entries };
  return entries;
}

/** 关键词过滤（检索文本子串，大小写不敏感；official 模式检索文本含中文
 *  关键词与中文文案，中文查询可直接命中）。lang=en 返回英文原描述卡片。 */
export async function searchSkillRegistry(
  query: string,
  limit: number,
  lang?: "zh" | "en",
): Promise<SkillRegistrySearchResponse> {
  const q = query.toLowerCase();
  const all = await loadManifest();
  const skills = all
    .filter((e) => e.searchText.includes(q))
    .slice(0, limit)
    .map((e) =>
      lang === "en"
        ? { ...e.card, title: undefined, description: e.enDesc }
        : e.card,
    );
  return { skills };
}
