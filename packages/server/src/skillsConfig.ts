import fs from "node:fs";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SkillInfo } from "@blm/protocol";
import { SkillName } from "@blm/protocol";
import { config } from "./config.js";
import { assertPublicHttpUrl } from "./mcpConfig.js";

// 专家技能配置：全局（data/skills/global/，管理员维护）+ 用户级
// （data/skills/users/<username>/，本人维护）。每个目录本身是一个 Claude Code
// 插件（.claude-plugin/plugin.json + skills/<name>/SKILL.md），会话启动时经
// SDK 的 plugins 选项挂载、skills 选项启用——本项目 settingSources 为空
// （隔离模式），这是唯一的技能注入通道。
//
// 技能是纯提示包：只注入指令文本，自身不执行任何东西；真正的文件/命令/浏览
// 操作仍走客户端代理工具及其确认流程。合并规则与 MCP 同构：我的同名覆盖全局。

export class SkillsConfigError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const GLOBAL_PLUGIN_NAME = "global-skills";
export const USER_PLUGIN_NAME = "user-skills";

export const MAX_SKILL_BYTES = 262_144; // 256KB，与协议侧 UpsertSkillRequest 上限一致

// 用户名会进数据目录路径（注册处无字符集限制），这里做双重校验防路径穿越。
const USERNAME_RE = /^[\w.-]{1,64}$/;

function globalDir(): string {
  return path.join(config.dataDir, "skills", "global");
}

function userDir(username: string): string | null {
  if (!username || !USERNAME_RE.test(username)) return null;
  return path.join(config.dataDir, "skills", "users", username);
}

function scopeDir(scope: "user" | "global", username: string): string | null {
  return scope === "global" ? globalDir() : userDir(username);
}

/** 确保目录具备插件结构（skills/ 与 .claude-plugin/plugin.json 缺失时补齐）。 */
function ensurePlugin(dir: string, pluginName: string): void {
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: pluginName, version: "1.0.0" }, null, 2));
  }
}

/** 宽松解析 SKILL.md 的 frontmatter（name/description/title；单行 key: value）。 */
function parseFrontmatter(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function metaOf(dir: string, name: string, source: "user" | "global"): SkillInfo | null {
  const file = path.join(dir, "skills", name, "SKILL.md");
  let markdown: string;
  let mtime: Date;
  try {
    markdown = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtime;
  } catch {
    return null;
  }
  const fm = parseFrontmatter(markdown);
  return {
    name,
    title: fm.title || fm.name || undefined,
    description: fm.description ?? "",
    source,
    updated_at: mtime.toISOString(),
  };
}

function listIn(dir: string, source: "user" | "global"): SkillInfo[] {
  const skillsDir = path.join(dir, "skills");
  let entries: string[];
  try {
    entries = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries) {
    if (!SkillName.safeParse(name).success) continue;
    const meta = metaOf(dir, name, source);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 合并视图：全局 + 我的（同名以我的为准）。目录不存在时对应侧为空。 */
export function listSkills(username: string): SkillInfo[] {
  const mineDir = userDir(username);
  const mine = mineDir ? listIn(mineDir, "user") : [];
  const mineNames = new Set(mine.map((s) => s.name));
  const globalList = listIn(globalDir(), "global").filter((s) => !mineNames.has(s.name));
  return [...globalList, ...mine];
}

/** 安装/更新一个技能（markdown 全文）。缺 frontmatter 直接拒绝：引擎靠
 *  description 决定何时调用，缺了基本不可用。 */
export function installSkillMarkdown(
  scope: "user" | "global",
  username: string,
  name: string,
  markdown: string,
): void {
  if (!SkillName.safeParse(name).success) throw new SkillsConfigError("invalid_name");
  if (Buffer.byteLength(markdown, "utf8") > MAX_SKILL_BYTES) {
    throw new SkillsConfigError("too_large");
  }
  if (!markdown.trimStart().startsWith("---")) {
    throw new SkillsConfigError("missing_frontmatter");
  }
  const dir = scopeDir(scope, username);
  if (!dir) throw new SkillsConfigError("invalid_name");
  ensurePlugin(dir, scope === "global" ? GLOBAL_PLUGIN_NAME : USER_PLUGIN_NAME);
  fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), markdown);
}

/** 从市场 URL 安装：公网 http/https（SSRF 过滤）→ 限长 → 当作 SKILL.md 写入。 */
export async function installSkillFromUrl(
  scope: "user" | "global",
  username: string,
  name: string,
  url: string,
): Promise<void> {
  await assertPublicHttpUrl(url);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "text/markdown, text/plain, text/*" },
    });
  } catch {
    throw new SkillsConfigError("download_failed");
  }
  if (!res.ok) throw new SkillsConfigError("download_failed");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_SKILL_BYTES) throw new SkillsConfigError("too_large");
  installSkillMarkdown(scope, username, name, buf.toString("utf8"));
}

export function deleteSkill(
  scope: "user" | "global",
  username: string,
  name: string,
): boolean {
  if (!SkillName.safeParse(name).success) return false;
  const dir = scopeDir(scope, username);
  if (!dir) return false;
  const skillsRoot = path.join(dir, "skills");
  const target = path.join(skillsRoot, name);
  // name 已过字符集校验，这里再兜底确保目标不会越出 skills/ 根目录。
  if (!target.startsWith(skillsRoot + path.sep)) return false;
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/** 全局技能原始列表（管理员端点）。 */
export function listGlobalSkills(): SkillInfo[] {
  return listIn(globalDir(), "global");
}

/** 我的技能原始列表。 */
export function listUserSkills(username: string): SkillInfo[] {
  const dir = userDir(username);
  return dir ? listIn(dir, "user") : [];
}

// ---------- 会话接入 ----------

export interface SkillSessionSetup {
  plugins: NonNullable<Options["plugins"]>;
  /** 生效技能的限定名（plugin:skill）；用户同名覆盖全局。 */
  skills: string[];
}

/** 会话启动用：挂载技能插件目录并计算生效技能清单。公有域会话传 undefined
 *  只挂全局（个人配置不进共享基础设施，与 MCP 的决定一致）。 */
export function sessionSkillSetup(username?: string): SkillSessionSetup {
  const setup: SkillSessionSetup = { plugins: [], skills: [] };

  const collect = (dir: string, pluginName: string, source: "user" | "global"): Set<string> => {
    const names = new Set<string>();
    if (!fs.existsSync(path.join(dir, "skills"))) return names;
    ensurePlugin(dir, pluginName);
    setup.plugins.push({ type: "local", path: dir, skipMcpDiscovery: true });
    for (const s of listIn(dir, source)) names.add(s.name);
    return names;
  };

  const globalNames = collect(globalDir(), GLOBAL_PLUGIN_NAME, "global");
  const mineDir = username ? userDir(username) : null;
  const userNames = mineDir ? collect(mineDir, USER_PLUGIN_NAME, "user") : new Set<string>();

  for (const name of new Set([...globalNames, ...userNames])) {
    setup.skills.push(
      userNames.has(name) ? `${USER_PLUGIN_NAME}:${name}` : `${GLOBAL_PLUGIN_NAME}:${name}`,
    );
  }
  setup.skills.sort();
  return setup;
}
