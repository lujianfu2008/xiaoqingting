# 小蜻蜓 Xiaoqingting

> 曾用名：白龙马（bailongma）

基于 Claude Agent SDK 的桌面聊天智能体：**Electron 桌面客户端 + Fastify 服务端**。引擎运行在服务端，文件/命令/浏览器等实际操作通过安全桥接在用户本机执行。

```
┌─────────────────┐  REST + WebSocket  ┌──────────────────┐
│  @blm/desktop   │ ◄────────────────► │   @blm/server    │
│  Electron 客户端 │   @blm/protocol    │  Fastify + SDK   │
│  聊天/语音/数字人 │    (Zod 校验)      │  会话/引擎/存储    │
└─────────────────┘                    └──────────────────┘
       ▲ 本机操作桥接（工具在用户电脑上执行）
```

## 功能特性

- **流式对话** — WebSocket 流式输出文本 / 工具调用 / 工具结果，支持中断
- **多角色智能体** — `assistant` / `coder` / `writer`，各自独立的模型与系统提示词
- **项目空间** — 会话按项目分组，项目绑定本机工作文件夹
- **本机操作桥接** — 引擎经客户端代理工具在用户电脑上执行命令、读写文件、浏览网页（`run_command` / `read_file` / `write_file` / `list_dir` / `browser_*`）
- **工具审批流** — 敏感操作弹窗确认，超时自动拒绝
- **MCP 扩展** — 内置 `server_time`，支持接入外部 MCP 服务器
- **多模态附件** — 消息可携带图片等附件
- **语音** — 离线中文语音识别（sherpa-onnx Paraformer）+ TTS 朗读
- **数字人** — three-vrm 形象展示
- **公有域与分享** — 项目可发布为公有域，支持分享与管理员审批
- **多用户** — JWT 登录、管理员页
- **自定义大模型** — 用户可在设置中填写自己的 LLM Key（服务端加密存储）
- **用量限额** — 按会话限制轮数（`MAX_TURNS`）与预算（`MAX_BUDGET_USD`）

## 快速开始

### 环境要求

- Node.js ≥ 20

### 1. 安装依赖

```bash
npm install
```

### 2. 配置并启动服务端

```bash
cp packages/server/.env.example packages/server/.env
# 编辑 packages/server/.env：
#   - JWT_SECRET 改为随机长字符串（务必）
#   - BLMA_USERNAME / BLMA_PASSWORD 设置登录账号
#   - 配置引擎 API（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 等）
npm run dev:server    # 默认监听 http://localhost:8788
```

### 3. 启动桌面端

```bash
npm run dev:desktop
```

启动后登录即可开始对话。生产部署参见 `deploy/`（systemd / Docker / nginx TLS 反代三个样例）。

### ASR 模型下载（新克隆必做）

桌面端离线语音识别的模型权重体积较大，**不入库**，需手动放置：

```
packages/desktop/models/sherpa-paraformer/
├── model.int8.onnx   ← 需自行下载（~79MB）
├── tokens.txt        ✓ 已入库
└── am.mvn            ✓ 已入库
```

从 [sherpa-onnx 官方 releases](https://github.com/k2-fsa/sherpa-onnx/releases)（asr-models）下载 `sherpa-onnx-paraformer-zh-small`，解压后将 `model.int8.onnx` 放入上述目录。

## 仓库不包含的内容（自动忽略）

| 内容 | 位置 | 说明 |
|---|---|---|
| 服务端密钥配置 | `packages/server/.env` | 真实密钥只留本机，模板见 `.env.example` |
| 运行时数据 | `packages/server/data/` | 会话历史、用户、加密的 LLM Key |
| ASR 模型权重 | `packages/desktop/models/*.onnx` | 见上方下载说明 |
| 本地安装包 | `*.tgz` | npm 可重新获取 |

## 开发

```bash
npm run typecheck    # 全工作区类型检查
npm run build        # 构建
```

架构约定（详见 `CLAUDE.md`）：

- 所有跨进程消息结构定义在 `@blm/protocol`，边界处用 Zod 校验
- 引擎细节（SDK 会话、原生工具名）只存在于服务端
- 所有会话/项目访问均做 `user_id` 归属校验

## ☕ 赞助支持

如果小蜻蜓对你有帮助，欢迎请作者喝杯咖啡~

<p align="center">
  <img src="docs/sponsor/wechat.png" alt="微信赞赏码" width="280" />
  <br/>
  <sub>微信赞赏</sub>
</p>
