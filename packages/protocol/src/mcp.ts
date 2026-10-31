import { z } from "zod";

// ---------- MCP 服务器管理 ----------

// 传输类型：stdio = 服务器上 spawn 子进程（等价服务器执行权限，仅管理员可配，
// 存全局配置）；http/sse = 远程 MCP 服务器（用户可自配，服务端对 URL 做私网
// 地址过滤防 SSRF）。
export const McpTransport = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransport>;

// 单个服务器定义。字段与 SDK 及 Claude Desktop / Cursor 的 mcpServers 配置
// 同构，因此市场页面复制的 JSON 片段可直接粘贴导入。enabled=false 表示
// 保留配置但暂不启用（用户同名配置可覆盖/屏蔽全局同名服务器）。
export const McpServerDef = z.object({
  type: McpTransport,
  url: z.string().max(2048).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().max(2048).optional(),
  args: z.array(z.string().max(2048)).max(64).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
export type McpServerDef = z.infer<typeof McpServerDef>;

// 服务器名会进入引擎工具名（mcp__<name>__<tool>），限定安全字符集。
export const McpServerName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "名称只能包含字母、数字、_ 和 -");
export type McpServerName = z.infer<typeof McpServerName>;

// 对单个名称的写入请求（PUT /api/mcp/servers/:name）。http/sse 必须带 url，
// stdio 必须带 command —— 在协议边界上校验。
export const UpsertMcpServerRequest = McpServerDef.superRefine((v, ctx) => {
  if (v.type === "stdio" && !v.command?.trim()) {
    ctx.addIssue({ code: "custom", message: "stdio 服务器需要提供 command" });
  }
  if ((v.type === "http" || v.type === "sse") && !v.url?.trim()) {
    ctx.addIssue({ code: "custom", message: "远程服务器需要提供 url" });
  }
});
export type UpsertMcpServerRequest = z.infer<typeof UpsertMcpServerRequest>;

// GET 返回的条目：定义 + 来源标记。全局条目对普通用户隐藏 header 值
// （headers_redacted = 该条目含鉴权头，仅键名可见）。
export const McpServerInfo = McpServerDef.extend({
  name: McpServerName,
  source: z.enum(["user", "global"]),
  // 仅 source=user：存在同名全局配置，本条覆盖（或屏蔽）了它。
  overrides_global: z.boolean().optional(),
  headers_redacted: z.boolean().optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const McpServersResponse = z.object({ servers: z.array(McpServerInfo) });
export type McpServersResponse = z.infer<typeof McpServersResponse>;

// 粘贴导入：接受 {"mcpServers":{...}}（Claude Desktop / Cursor / 多数 MCP
// 市场给出的格式）或裸的 {名称: 定义} 映射。scope=global 仅管理员可用，
// 允许导入 stdio；用户级导入只接受远程服务器。
export const ImportMcpRequest = z.object({
  json: z.string().min(2).max(100_000),
  scope: z.enum(["user", "global"]).optional(),
});
export type ImportMcpRequest = z.infer<typeof ImportMcpRequest>;

export const ImportMcpResult = z.object({
  imported: z.array(McpServerName),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type ImportMcpResult = z.infer<typeof ImportMcpResult>;

// ---------- MCP 市场（官方 Registry 搜索代理） ----------

// 服务端把 registry.modelcontextprotocol.io 的原始条目规范化成可安装卡片；
// remote / pkg 至少一个存在。install_name 是落配置时用的服务器名（已按
// [a-zA-Z0-9_-] 清洗，与 McpServerName 规则一致）。
export const McpRegistryCard = z.object({
  id: z.string(), // registry 规范名，如 io.github/user/some-server
  install_name: McpServerName,
  title: z.string().optional(),
  description: z.string(),
  version: z.string().optional(),
  // 远程安装项（streamable-http → http）。needs_auth = 远端要求带凭证头
  // （header 值含 {占位符}），安装后需在编辑表单补真实 token。
  remote: z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.string(),
      needs_auth: z.boolean().optional(),
    })
    .optional(),
  // 本机进程安装项（stdio，仅管理员可装到全局）。
  pkg: z
    .object({
      registry_type: z.string(), // npm / pypi（其余类型不给出安装项）
      identifier: z.string(),
      version: z.string().optional(),
      env_required: z.array(z.string()).optional(), // 必填环境变量名
    })
    .optional(),
});
export type McpRegistryCard = z.infer<typeof McpRegistryCard>;

export const McpRegistrySearchResponse = z.object({
  servers: z.array(McpRegistryCard),
  next_cursor: z.string().optional(),
});
export type McpRegistrySearchResponse = z.infer<typeof McpRegistrySearchResponse>;
