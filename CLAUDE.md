# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

小蜻蜓 (Xiaoqingting) — a chat-agent product: a TypeScript monorepo with an Electron desktop client talking to a Fastify server that wraps the Claude Agent SDK. UI text and prompts are in Chinese.

## Commands

```bash
npm run dev:server    # server dev with tsx watch (packages/server)
npm run dev:desktop   # electron-vite dev (packages/desktop)
npm run typecheck     # tsc --noEmit in all workspaces
npm run build         # typecheck-only for server/protocol; electron-vite build for desktop
```

- Server runs on `PORT` (default 8788); no build step — it runs TS directly via tsx.
- No test framework exists yet.
- Server secrets/config live in `packages/server/.env` (see `.env.example`); the server loads it itself in `config.ts` (does not override existing env vars). Requires Node >= 20.

## Architecture

Three workspaces under `packages/`:

- **@blm/protocol** — Zod schemas + types for everything crossing a process boundary: chat `Block` types (`user_text`/`text`/`tool_call`/`tool_result`), `ClientMessage`/`ServerMessage` WS unions, and REST payloads. Both client and server import from here; it's source-imported (main/types point at `src/index.ts`), not built.

- **@blm/server** — Fastify app (`src/index.ts`) with REST + WebSocket:
  - **REST** (`rest/routes.ts`): `POST /auth/login` → JWT; JWT-authenticated `GET /api/agents`, `GET|POST /api/sessions`, `GET /api/sessions/:id/messages`, `POST /api/sessions/:id/title`（重命名）, `DELETE /api/sessions/:id`. Auth hook exempts `/auth/`, `/health`, `/ws`. `/auth/login` 有限流（`rateLimit.ts`：用户名+IP 15 分钟内错 5 次锁 15 分钟；注册 10 次/小时/IP），429 带 `retry_after`。
  - **WS** (`ws/handler.ts`): `/ws?token=<jwt>`; client sends `user_message`/`interrupt`/`permission_response`; server streams `message_delta`, `message_block`, `permission_request`, `result`（含 `usage` token 数；`cost_usd` 仅 `REVEAL_USAGE=true` 时有值）, `error`（`code: "kicked"` = 被管理员强制下线）, `review_request`（待审核注册数，推给在线审核员，上线补推）.
  - **审计** (`audit.ts`): 管理动作（角色/禁用/启用/重置密码/踢下线/审核通过拒绝）追加 `data/audit.jsonl`（10MB 轮转 `.old`；detail 绝不含密码明文/哈希）。`GET /api/admin/audit?limit=`（仅管理员）倒序读取；管理页「操作日志」tab 展示。强制下线：`POST /api/admin/users/:username/kick`（仅管理员，不可踢 bootstrap/自己）。
  - **AgentManager** (`agent/AgentManager.ts`): routes WS traffic to per-session `AgentSession`s and broadcasts server messages to *all* of a user's connections. Sessions are lazily created on first message.
  - **AgentSession** (`agent/AgentSession.ts`): wraps one SDK `query()` call with a push-based `TurnQueue` as streaming input. The engine loop stays alive across turns and idle-disposes after `SESSION_IDLE_MS`. Resume works by persisting the SDK's `session_id` as `engine_session_id` in the session record. Tool approvals flow through `canUseTool` → `permission_request` over WS → client responds; timeout auto-denies (`PERMISSION_TIMEOUT_MS`).
  - **Agent roles** (`agent/agents.ts`): hardcoded role map (`assistant`/`coder`/`writer`) → SDK options (model, systemPrompt, tool allowlists, permissionMode). Clients only see `AgentInfo`.
  - **MCP** (`agent/mcp.ts`): a per-session in-process SDK MCP server (`blm-builtin`: only `server_time`) plus optional external servers, and a client-proxy MCP server (`agent/clientTools/`, `mcp__client__*`) whose tools (`run_command`/`read_file`/`write_file`/`list_dir`/`get_workdir`/`choose_workdir`/`browser_*`) execute on the user's machine over WS (`tool_exec_request`/`tool_exec_result`). Engine tool names are sanitized before reaching the client (`sanitizeToolName`, e.g. `Read`→`read_file`, `mcp__x__y`→`y`) — the client must never see engine-native names. 外部 MCP 配置两层（`mcpConfig.ts` 管理，合并优先级 builtin < 全局 < 用户同名覆盖）：全局 `data/mcp.json`（管理员，任意传输含 stdio，REST `/api/admin/mcp/*`，变更写审计）；用户级 `data/mcp-users.json`（仅远程 http/sse，REST `/api/mcp/*`，URL 强制过私网过滤防 SSRF）。粘贴导入 `POST /api/mcp/import`（兼容 MCP 市场 / Claude Desktop / Cursor 的 `mcpServers` JSON，`scope:"global"` 仅管理员）。市场搜索走官方 Registry 代理 `GET /api/mcp/registry/search`（`mcpRegistry.ts` 规范化成可安装卡片，上游可用 `MCP_REGISTRY_URL` 换；安装复用上面的写入端点，stdio 卡片仅管理员可装到全局）。配置写入后丢弃空闲会话，下一条消息生效；桌面端在设置的「MCP 服务器」tab 管理（列表/表单/粘贴导入/市场搜索）。
  - **专家技能** (`skillsConfig.ts`/`skillRegistry.ts`，REST `rest/skillRoutes.ts`): 纯提示型技能（SKILL.md 指令包，不支持脚本型技能包——本产品执行全在用户本机）。存储即 Claude Code 插件目录：全局 `data/skills/global/`、用户级 `data/skills/users/<username>/`（各自含 `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`），会话启动经 SDK `plugins`（`skipMcpDiscovery`）+ `skills` 选项挂载——`settingSources: []` 下唯一注入通道；Skill 工具在 `canUseTool` 自动放行、`sanitizeToolName` 映射为 `use_skill`。合并规则同 MCP：我的同名覆盖全局；公有域会话只挂全局。REST：用户 `GET|PUT|DELETE /api/skills/:name`、`POST /api/skills/import`（`{"skills":[{name,markdown}]}` 或 `{名称: markdown}`）、`POST /api/skills/install`（市场安装，服务端下载 SKILL.md，256KB 上限）；全局 `/api/admin/skills/*`（写审计 `skills.global_save/global_delete`）；市场搜索 `GET /api/skills/registry/search` 代理 `SKILLS_REGISTRY_URL` 清单（`{"skills":[...]}`，空 = 搜索不可用，安装/导入不受影响）。桌面端设置「专家技能」tab（列表/表单/粘贴导入/市场）。
  - **Store** (`store.ts`): file-based persistence under `DATA_DIR` — `sessions/<id>.json` (metadata incl. `user_id`, `project_id?`, `cwd`, `engine_session_id`) and `sessions/<id>.jsonl` (block history); `projects/<id>.json` (project spaces, incl. `user_id`). The per-session `workspaces/<userId>/<sessionId>` dir and `rec.cwd` are vestigial (written, never read); the engine `cwd` is the neutral `DATA_DIR/engine` for all sessions — real file/command execution happens on the user's machine via the client-proxy tools, not on the server.
  - **Projects**: a project groups sessions (`project_id` on the session record; null = 默认空间). REST: `GET|POST /api/projects`, `DELETE /api/projects/:id`. Deleting a project demotes its sessions to the default space. The project's actual working folder lives only in the desktop's `settings.json` (`projectFolders`), never on the server.
  - **Users & 审核制注册** (`users.ts`): file-backed `data/users.json`; `POST /auth/register` creates a `status: "pending"` account and returns no token — login/REST-hook/WS all reject non-`approved` accounts (`pending_review`/`review_rejected`), so a pending user can use nothing until 管理员或其授权的审核员（`reviewer` 角色，经 `/api/admin/users/:username/role` 授予）通过 `POST /api/review/users/:username/decide`. Legacy rows without `status` are treated as `approved`. 密码：本人改密 `POST /api/me/password`（验旧密码，写入 `password_changed_at`，此前签发的 token 被 REST 钩子/WS 判为 `token_stale` 强制重新登录）；管理员重置 `POST /api/admin/users/:username/password`（并强制目标用户下线）。bootstrap admin (`.env`) is immutable and always approved/admin — its password only changes in `.env` (`BLMA_PASSWORD`).

- **@blm/desktop** — Electron + React (electron-vite). Main process (`src/main/index.ts`) is a thin BrowserWindow shell; all logic is in the renderer (`src/renderer/src/`): zustand store (`store.ts`), components for chat, sidebar, login, and permission dialogs. Talks to the server over REST + WS (no IPC bridge beyond the preload).

## Key invariants

- All message shapes must be defined in `@blm/protocol` and validated with Zod at the boundary — never hand-roll JSON shapes in handler/client code.
- Engine details (SDK session ids, native tool names, engine options) stay server-side; only protocol types cross the WS.
- Ownership checks: every session access goes through `user_id` comparison in `AgentManager`/`Store`; keep this pattern for new endpoints.
- Engine tool gate is default-deny: `canUseTool` auto-allows only `Skill`/`TodoWrite`/`mcp__blm-builtin__*`/client/public proxy tools, denies every engine-native (non-`mcp__`) tool outright without prompting, and routes external `mcp__*` through user confirmation. `allowedTools`/`disallowedTools` are prompt hygiene only — never the enforcement.
- The engine subprocess env must be stripped of server secrets (`JWT_SECRET`, `CREDENTIAL_SECRET`, `BLMA_*`, `ASR_API_KEY`) in `sessionOptions.ts`; only `ANTHROPIC_*` auth vars may cross. Never pass `process.env` to the engine unfiltered.
