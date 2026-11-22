import { z } from "zod";

// ---------- 专家技能管理 ----------

// 技能（skill）= 一份 SKILL.md 指令包（纯提示型）：引擎在匹配的任务上把内容
// 注入上下文。本产品所有执行都在用户本机（客户端代理工具），因此只支持纯文档
// 技能，不支持带脚本的技能包。安装即可用（可停用：停用的技能不挂会话、不可
// 斜杠呼叫，配置保留）；卸载即删除；我的同名技能覆盖全局同名技能（与 MCP 的
// 合并规则同构）。

export const SkillName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "名称只能包含字母、数字、_ 和 -");
export type SkillName = z.infer<typeof SkillName>;

// 安装/更新：直接提交 SKILL.md 全文（256KB 上限）。
export const UpsertSkillRequest = z.object({
  markdown: z.string().min(12).max(262_144),
});
export type UpsertSkillRequest = z.infer<typeof UpsertSkillRequest>;

// GET 返回条目（服务端从 SKILL.md frontmatter 解析，不回传全文）。
// enabled 缺省 = 启用（旧服务端不发此字段，向后兼容）。
export const SkillInfo = z.object({
  name: SkillName,
  title: z.string().optional(),
  description: z.string(),
  source: z.enum(["user", "global"]),
  updated_at: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

export const SkillsResponse = z.object({
  skills: z.array(SkillInfo),
});
export type SkillsResponse = z.infer<typeof SkillsResponse>;

// 启用/停用一个技能（配置保留；停用的不挂会话、不可斜杠呼叫）。
export const EnableSkillRequest = z.object({
  enabled: z.boolean(),
});
export type EnableSkillRequest = z.infer<typeof EnableSkillRequest>;

// GET /api/skills/:name 返回 SKILL.md 全文（编辑表单预填；256KB 上限同安装）。
export const SkillMarkdownResponse = z.object({
  markdown: z.string().max(262_144),
});
export type SkillMarkdownResponse = z.infer<typeof SkillMarkdownResponse>;

// 粘贴导入：{"skills":[{"name":"...","markdown":"..."},...]} 或裸的 {名称: markdown}。
export const ImportSkillsRequest = z.object({
  json: z.string().min(2).max(1_000_000),
  scope: z.enum(["user", "global"]).optional(),
});
export type ImportSkillsRequest = z.infer<typeof ImportSkillsRequest>;

// 压缩包安装：zip 内容 base64 随 JSON 上传（≤20MB 原始压缩包）。布局自适应——
// 单技能 / 多技能目录 / 仓库整体下载（自动剥公共包装层）；每技能仅提取 SKILL.md，
// 返回结构同 ImportSkillsResult（imported/skipped）。
export const ImportArchiveRequest = z.object({
  archive: z.string().min(8).max(30_000_000),
  scope: z.enum(["user", "global"]).optional(),
  filename: z.string().max(255).optional(),
});
export type ImportArchiveRequest = z.infer<typeof ImportArchiveRequest>;

export const ImportSkillsResult = z.object({
  imported: z.array(SkillName),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type ImportSkillsResult = z.infer<typeof ImportSkillsResult>;

// 从市场安装：服务端下载 url 指向的 SKILL.md（公网 http/https）后写入。
// scope=global 仅管理员。
// name 放宽为任意非空串：市场清单/第三方 SKILL.md 的名字五花八门
// （空格、点、中文都有），服务端按 frontmatter 优先 + 规范化兜底落库，
// 最终名字随响应返回（客户端以返回值为准展示）。
export const InstallSkillRequest = z.object({
  name: z.string().min(1).max(200),
  url: z.string().max(2048),
  scope: z.enum(["user", "global"]).optional(),
});
export type InstallSkillRequest = z.infer<typeof InstallSkillRequest>;

export const InstallSkillResponse = z.object({
  ok: z.literal(true),
  name: SkillName,
});
export type InstallSkillResponse = z.infer<typeof InstallSkillResponse>;

// ---------- 专家市场（清单式上游） ----------

// SKILLS_REGISTRY_URL 指向一份 JSON 清单：
// {"skills":[{"name":"...","title":"...","description":"...","url":"https://…/SKILL.md","version":"1.0.0"}]}
// 服务端拉取清单、按关键词过滤后返回卡片；安装仍走上面的写入端点。

export const SkillRegistryCard = z.object({
  id: z.string(),
  install_name: SkillName,
  title: z.string().optional(),
  description: z.string(),
  version: z.string().optional(),
  url: z.string(),
});
export type SkillRegistryCard = z.infer<typeof SkillRegistryCard>;

export const SkillRegistrySearchResponse = z.object({
  skills: z.array(SkillRegistryCard),
});
export type SkillRegistrySearchResponse = z.infer<typeof SkillRegistrySearchResponse>;
