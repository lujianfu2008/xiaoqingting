# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

小蜻蜓 (Xiaoqingting，曾用名白龙马) — a chat-agent product: a TypeScript monorepo with an Electron desktop client talking to a Fastify server that wraps the Claude Agent SDK. UI text and prompts are in Chinese.

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
  - **REST** (`rest/routes.ts`): `POST /auth/login` → JWT; JWT-authenticated `GET /api/agents`, `GET|POST /api/sessions`, `GET /api/sessions/:id/messages`, `DELETE /api/sessions/:id`. Auth hook exempts `/auth/`, `/health`, `/ws`.
  - **WS** (`ws/handler.ts`): `/ws?token=<jwt>`; client sends `user_message`/`interrupt`/`permission_response`; server streams `message_delta`, `message_block`, `permission_request`, `result`, `error`.
  - **AgentManager** (`agent/AgentManager.ts`): routes WS traffic to per-session `AgentSession`s and broadcasts server messages to *all* of a user's connections. Sessions are lazily created on first message.
  - **AgentSession** (`agent/AgentSession.ts`): wraps one SDK `query()` call with a push-based `TurnQueue` as streaming input. The engine loop stays alive across turns and idle-disposes after `SESSION_IDLE_MS`. Resume works by persisting the SDK's `session_id` as `engine_session_id` in the session record. Tool approvals flow through `canUseTool` → `permission_request` over WS → client responds; timeout auto-denies (`PERMISSION_TIMEOUT_MS`).
  - **Agent roles** (`agent/agents.ts`): hardcoded role map (`assistant`/`coder`/`writer`) → SDK options (model, systemPrompt, tool allowlists, permissionMode). Clients only see `AgentInfo`.
  - **MCP** (`agent/mcp.ts`): a per-session in-process SDK MCP server (`blm-builtin`: only `server_time`) plus optional external servers from `data/mcp.json`, and a client-proxy MCP server (`agent/clientTools/`, `mcp__client__*`) whose tools (`run_command`/`read_file`/`write_file`/`list_dir`/`get_workdir`/`choose_workdir`/`browser_*`) execute on the user's machine over WS (`tool_exec_request`/`tool_exec_result`). Engine tool names are sanitized before reaching the client (`sanitizeToolName`, e.g. `Read`→`read_file`, `mcp__x__y`→`y`) — the client must never see engine-native names.
  - **Store** (`store.ts`): file-based persistence under `DATA_DIR` — `sessions/<id>.json` (metadata incl. `user_id`, `project_id?`, `cwd`, `engine_session_id`) and `sessions/<id>.jsonl` (block history); `projects/<id>.json` (project spaces, incl. `user_id`). The per-session `workspaces/<userId>/<sessionId>` dir and `rec.cwd` are vestigial (written, never read); the engine `cwd` is the neutral `DATA_DIR/engine` for all sessions — real file/command execution happens on the user's machine via the client-proxy tools, not on the server.
  - **Projects**: a project groups sessions (`project_id` on the session record; null = 默认空间). REST: `GET|POST /api/projects`, `DELETE /api/projects/:id`. Deleting a project demotes its sessions to the default space. The project's actual working folder lives only in the desktop's `settings.json` (`projectFolders`), never on the server.

- **@blm/desktop** — Electron + React (electron-vite). Main process (`src/main/index.ts`) is a thin BrowserWindow shell; all logic is in the renderer (`src/renderer/src/`): zustand store (`store.ts`), components for chat, sidebar, login, and permission dialogs. Talks to the server over REST + WS (no IPC bridge beyond the preload).

## Key invariants

- All message shapes must be defined in `@blm/protocol` and validated with Zod at the boundary — never hand-roll JSON shapes in handler/client code.
- Engine details (SDK session ids, native tool names, engine options) stay server-side; only protocol types cross the WS.
- Ownership checks: every session access goes through `user_id` comparison in `AgentManager`/`Store`; keep this pattern for new endpoints.
