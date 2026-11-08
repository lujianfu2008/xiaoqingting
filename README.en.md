# Xiaoqingting (小蜻蜓) — Your Fully-Local AI Assistant

A local-first AI assistant built on the Claude Agent SDK: **Electron desktop client + Fastify server**. All interactions flow through your own server — voice input, conversations, and tool execution stay on hardware you control.

```
┌─────────────────┐   REST + WebSocket   ┌─────────────────┐
│   @blm/desktop  │ ◄──────────────────► │   @blm/server   │
│                 │                      │                 │
│ Electron client │                      │  Fastify + SDK  │
│ voice / chat /  │                      │  agents / auth  │
│ tools / browser │                      │  gateway / keys │
└─────────────────┘                      └─────────────────┘
        ▲                                        ▲
        └── 3D avatar (three-vrm), offline ASR    └── local tool execution
```

## Features

- **Multi-session realtime** — WebSocket live channels, session following, conflict handling
- **Multi-agent orchestration** — `assistant` / `coder` / `writer`, each with its own responsibilities and toolsets
- **Skills system** — skill packs auto-discovered and injected into the system prompt
- **Local tool execution** — the server runs tools in a local session: shell commands, file read/write, directory listing, browser control
- **Browser-extension voice input** — Chrome extension for voice dictation on any page
- **MCP support** — built-in `server_time`, hook up any MCP server
- **Offline speech recognition** — local sherpa-onnx Paraformer + streaming TTS
- **3D avatar** — driven by three-vrm
- **Local-first** — voice and conversation processing happen locally; the server only relays
- **Multi-user** — JWT auth, per-user data isolation
- **Gateway billing** — centrally manage upstream LLM keys with per-user quotas
- **Usage analytics** — per-user / per-model stats, `MAX_TURNS` and budget (`MAX_BUDGET_USD`) limits

## Getting Started

### Requirements

- Node.js ≥ 20

### 1. Install

```bash
npm install
```

### 2. Configure the server

```bash
cp packages/server/.env.example packages/server/.env
# Edit packages/server/.env:
#   - JWT_SECRET: change to a strong random string (required)
#   - BLMA_USERNAME / BLMA_PASSWORD: initial account (required)
#   - Upstream API: ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL (required)
npm run dev:server   # local server at http://localhost:8788
```

### 3. Start the desktop client

```bash
npm run dev:desktop
```

For production, see `deploy/` (systemd / Docker / nginx TLS examples included).

### Offline ASR model (optional)

The speech recognition model lives by default in `packages/desktop/models/sherpa-onnx-paramformer/` (**not committed**):

```
packages/desktop/models/sherpa-onnx-paramformer/
├── model.int8.onnx    # streaming model (~79 MB)
├── tokens.txt
└── am.mvn
```

Download `sherpa-onnx-paramformer-zh-small` from the [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) (asr-models section), then extract the three files above into place.

## What Never Gets Committed (by design)

| Content | Location | Why |
|---|---|---|
| Server environment | `packages/server/.env` | keys and admin account — see `.env.example` |
| Data directory | `packages/server/data/` | conversations, users, upstream LLM keys |
| ASR model files | `packages/desktop/models/*.onnx` | large binaries |
| Type declarations | `*.tgz` | npm build artifacts |

## Development

```bash
npm run typecheck   # protocol type checking
npm run build       # build all packages
```

More design notes in [CLAUDE.md](CLAUDE.md).

## License

MIT © 2026 [lujianfu2008](https://github.com/lujianfu2008)

> **Fully open source**: client, server and protocol layers are all published in this repository under the MIT license — free to use, modify, commercialize and redistribute.
>
> The only things left out are large model weights (`.onnx`) and local secret config (`.env`), see "What Never Gets Committed" above.

## Notes

- Shared session types live in `@blm/protocol`, validated with Zod
- Tool approvals: the SDK provides built-in gating, configurable on the server
- Multi-user / multi-agent isolation keys on `user_id`

## ☕ Support

If this project helps you, consider buying the author a coffee:

<p align="center">
  <img src="docs/sponsor/wechat.png" alt="WeChat sponsorship" width="280" />
  <br/>
  <sub>Buy me a coffee</sub>
</p>
