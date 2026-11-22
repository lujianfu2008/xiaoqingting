import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SkillInfo } from "@blm/protocol";
import { SkillName } from "@blm/protocol";
import { config } from "./config.js";
import { assertPublicHttpUrl } from "./mcpConfig.js";

// 专家技能配置：全局（data/skills/global/，管理员维护）+ 用户级
// （data/skills/users/<username>/，本人维护）。每个目录本身是一个
// 引擎插件包（.claude-plugin/plugin.json + skills/<name>/SKILL.md，
// 目录/清单文件名是引擎挂载协议要求，属于内部结构），会话启动时经
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

// 用户名会进数据目录路径。注册处允许中文等任意字符（工号/用户名两命名
// 空间），这里不能按 ASCII 白名单拒中文——只做路径安全校验：长度限制 +
// 拒绝路径分隔符/穿越/控制字符，保留中文等 Unicode 用户名。
const USERNAME_OK_RE = /^[^\0/\\:.][^\0/\\:.]{0,62}$/;

function globalDir(): string {
  return path.join(config.dataDir, "skills", "global");
}

function userDir(username: string): string | null {
  // `..` 单独出现即路径穿越；其余由上面的字符集兜住（:. / \ 全拒，
  // 文件名不会带盘符/分隔符）。空串、超长、控制字符都被 USERNAME_OK_RE 拒掉。
  if (!username || username.length > 63 || !USERNAME_OK_RE.test(username)) return null;
  if (username === ".." || username.endsWith(".")) return null;
  return path.join(config.dataDir, "skills", "users", username);
}

function scopeDir(scope: "user" | "global", username: string): string | null {
  return scope === "global" ? globalDir() : userDir(username);
}

/** 确保目录具备插件结构（skills/ 与清单文件缺失时补齐）。 */
function ensurePlugin(dir: string, pluginName: string): void {
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: pluginName, version: "1.0.0" }, null, 2));
  }
}

/** 从 SKILL.md 的 frontmatter 取指定字段：容忍单行、YAML 折叠（>）与块（|）
 *  标量，不引 YAML 库。找不到返回 null。市场清单与已安装列表共用。 */
export function readFrontmatterField(md: string, field: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = new RegExp(`^${field}:\\s*(.*)$`).exec(lines[i]);
    if (!kv) continue;
    const inline = kv[1].trim();
    if (!/^(>[1-9]?[-+]?|\|[1-9]?[-+]?)$/.test(inline)) {
      return inline.replace(/^["']|["']$/g, "") || null;
    }
    // 块/折叠标量：收后续缩进行，遇非缩进行（新顶层键或 frontmatter 结束）停。
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      parts.push(lines[j].trim());
    }
    return parts.join(" ") || null;
  }
  return null;
}

/** 宽松解析 SKILL.md 的 frontmatter（name/description/title；单行 key: value，
 *  这三个关键字段另过折叠/块标量容忍解析——官方技能库大量使用多行描述，
 *  纯单行解析会把指示符 ">" 当成描述）。 */
function parseFrontmatter(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const f of ["name", "title", "description"] as const) {
    const v = readFrontmatterField(markdown, f);
    if (v !== null && v !== "") out[f] = v;
  }
  return out;
}

/** 停用标记：技能目录下的点文件（存在 = 停用）。配置与内容保留，删技能即消失。 */
function disabledMarker(dir: string, name: string): string {
  return path.join(dir, "skills", name, ".disabled");
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
    enabled: !fs.existsSync(disabledMarker(dir, name)),
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

/** 把任意来源的名字压成合法技能名：非法字符 → '-'、折叠连串、
 *  掐头（首字符必须字母数字）去尾，限长 64。产出可能为空串
 *  （调用方须再判 SkillName）。保留大小写（既有合法名含混合大小写）。 */
export function slugifySkillName(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s;
}

/** 从市场 URL 安装：公网 http/https（SSRF 过滤）→ 限长 → 当作 SKILL.md 写入。
 *  落库名解析：SKILL.md frontmatter 的 name 合法则优先（与压缩包安装的
 *  「frontmatter 名优先」同一语义），否则把 frontmatter 名/请求名规范化
 *  （市场清单与第三方技能的名字五花八门——空格、点、中文都有，直接拒绝
 *  只会逼用户放弃安装）。返回最终落库名，调用方随响应告知客户端。 */
export async function installSkillFromUrl(
  scope: "user" | "global",
  username: string,
  name: string,
  url: string,
): Promise<string> {
  await assertPublicHttpUrl(url);
  const tryFetch = (u: string, timeoutMs: number): Promise<Response | null> =>
    fetch(u, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/markdown, text/plain, text/*" },
    }).catch(() => null);
  let res = await tryFetch(url, 12_000);
  if (!res || !res.ok) {
    const prefix = config.skillsRegistryGhProxy;
    const direct =
      prefix && url.startsWith(`${prefix}/`) ? url.slice(prefix.length + 1) : null;
    if (direct) {
      await assertPublicHttpUrl(direct);
      res = await tryFetch(direct, 25_000);
    }
  }
  if (!res || !res.ok) throw new SkillsConfigError("download_failed");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_SKILL_BYTES) throw new SkillsConfigError("too_large");
  const markdown = buf.toString("utf8");
  const fmName = readFrontmatterField(markdown, "name") ?? "";
  const candidates = [fmName, slugifySkillName(fmName), slugifySkillName(name)];
  const finalName =
    candidates.find((c) => c.length > 0 && SkillName.safeParse(c).success) ?? null;
  if (!finalName) throw new SkillsConfigError("invalid_name");
  installSkillMarkdown(scope, username, finalName, markdown);
  return finalName;
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

// ---------- 压缩包安装 ----------

export interface ArchiveInstallResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
}

export const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

/** 压缩包里识别出的技能候选：SKILL.md 前的路径段 + 内容。 */
interface ArchiveSkill {
  segs: string[];
  md: string;
}

/** 名字收敛到 SkillName 字符集；失败返回空串。 */
function sanitizeSkillName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 64);
  return SkillName.safeParse(cleaned).success ? cleaned : "";
}

/** 文件名 → 技能名兜底（剥扩展名再收敛；用于根目录单 SKILL.md 的 zip）。 */
function stemFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^./\\]*$/, "").split(/[\\/]/).pop() ?? "";
  return sanitizeSkillName(stem) || "skill";
}

/** 多个技能路径的公共前缀长度（剥 GitHub 整仓下载的包装层用）。 */
function commonPrefixLen(list: string[][]): number {
  if (list.length === 0) return 0;
  const minLen = Math.min(...list.map((s) => s.length));
  let i = 0;
  while (i < minLen && list.every((s) => s[i] === list[0][i])) i++;
  // 前缀不能吃掉某个路径的全部段（"x" vs "x/sub" 时退一格留子目录名）。
  if (i > 0 && list.some((s) => s.length === i)) i--;
  return i;
}

/** 技能目录子树内是否带脚本（.py/.sh/.ps1/.bat/.exe/.js/.ts 或 scripts/ 目录）
 *  ——本产品技能是纯提示包，脚本整包跑不了，整组跳过如实告知。 */
function hasScripts(dirPrefix: string, allPaths: string[]): boolean {
  const scriptExt = /\.(py|sh|ps1|bat|exe|js|ts)$/i;
  return allPaths.some((p) => {
    if (!p.startsWith(dirPrefix) || p === dirPrefix) return false;
    return scriptExt.test(p) || p.slice(dirPrefix.length).split("/").includes("scripts");
  });
}

/** 压缩包安装（zip，布局自适应）：扫描压缩包内任意深度的 SKILL.md，
 *  frontmatter name 优先、目录名兜底（多技能剥公共包装层、单技能剥首层仓库
 *  目录）；每技能只提取 SKILL.md 写入（落盘路径全部由校验过的 name 构造，
 *  zip 里的路径段不参与拼接，路径穿越无从谈起）。无 SKILL.md / 非 zip /
 *  超限直接抛错码。 */
export function installSkillsFromArchive(
  scope: "user" | "global",
  username: string,
  archive: Buffer,
  filename: string,
): ArchiveInstallResult {
  if (archive.byteLength > ARCHIVE_MAX_BYTES) throw new SkillsConfigError("too_big");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(archive));
  } catch {
    throw new SkillsConfigError("bad_archive");
  }
  const allPaths = Object.keys(files);
  const found: ArchiveSkill[] = [];
  for (const p of allPaths) {
    const segs = p.split("/");
    // 跳过路径穿越段、隐藏目录（.git 等）与 macOS 打包碎片。
    if (segs.some((s) => s === ".." || s.startsWith(".") || s === "__MACOSX")) continue;
    if (segs[segs.length - 1] !== "SKILL.md") continue;
    found.push({ segs: segs.slice(0, -1), md: Buffer.from(files[p]).toString("utf8") });
  }
  if (found.length === 0) throw new SkillsConfigError("no_skills");

  const stem = stemFromFilename(filename);
  const wrapLen =
    found.length > 1
      ? commonPrefixLen(found.map((f) => f.segs))
      : found[0]!.segs.length > 1
        ? 1
        : 0;

  const result: ArchiveInstallResult = { imported: [], skipped: [] };
  const taken = new Set<string>();
  for (const f of found) {
    const rest = f.segs.slice(wrapLen);
    const dirName = rest.length > 0 ? rest[rest.length - 1]! : "";
    const fmName = readFrontmatterField(f.md, "name");
    let name = "";
    if (fmName && SkillName.safeParse(fmName).success) name = fmName;
    if (!name) name = sanitizeSkillName(dirName || stem);
    if (!name) {
      result.skipped.push({ name: dirName || "(根目录)", reason: "invalid_name" });
      continue;
    }
    if (taken.has(name)) {
      result.skipped.push({ name, reason: "dup_name" });
      continue;
    }
    taken.add(name);
    const dirPrefix = f.segs.length > 0 ? `${f.segs.join("/")}/` : "";
    if (dirPrefix && hasScripts(dirPrefix, allPaths)) {
      result.skipped.push({ name, reason: "script_bundle" });
      continue;
    }
    try {
      installSkillMarkdown(scope, username, name, f.md);
      result.imported.push(name);
    } catch (e) {
      result.skipped.push({
        name,
        reason: e instanceof SkillsConfigError ? e.code : "unknown",
      });
    }
  }
  return result;
}

/** 全局技能原始列表（管理员端点）。 */
export function listGlobalSkills(): SkillInfo[] {
  return listIn(globalDir(), "global");
}

/** 启用/停用：写/删技能目录下的停用标记。false = 停用。目标不存在返回 false。 */
export function setSkillEnabled(
  scope: "user" | "global",
  username: string,
  name: string,
  enabled: boolean,
): boolean {
  if (!SkillName.safeParse(name).success) return false;
  const dir = scopeDir(scope, username);
  if (!dir) return false;
  const skillsRoot = path.join(dir, "skills");
  const target = path.join(skillsRoot, name);
  if (!target.startsWith(skillsRoot + path.sep)) return false;
  if (!fs.existsSync(target)) return false;
  const marker = disabledMarker(dir, name);
  if (enabled) {
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  } else if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "");
  }
  return true;
}

/** 读技能 SKILL.md 全文（编辑表单预填）。目标不存在返回 null。 */
export function readSkillMarkdown(
  scope: "user" | "global",
  username: string,
  name: string,
): string | null {
  if (!SkillName.safeParse(name).success) return null;
  const dir = scopeDir(scope, username);
  if (!dir) return null;
  const skillsRoot = path.join(dir, "skills");
  const file = path.join(skillsRoot, name, "SKILL.md");
  if (!file.startsWith(skillsRoot + path.sep)) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
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
    // 停用的技能不挂会话（用户停用自己的覆盖名时，全局同名版本重新生效）。
    for (const s of listIn(dir, source)) {
      if (s.enabled !== false) names.add(s.name);
    }
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
