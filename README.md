# Xiaoqingting (小蜻蜓) — 你的全本地 AI 助手

> **全本地、数据不出机、自己会发文、自己会修 Bug、自己会长大**

桌面聊天智能体：**Electron 桌面客户端 + Fastify 服务端**。引擎运行在服务端，文件/命令/浏览器等实际操作通过安全桥接在用户本机执行。

```
┌─────────────────┐   REST + WebSocket   ┌─────────────────┐
│   @blm/desktop  │ ◄──────────────────► │   @blm/server   │
│                 │                      │                 │
│ Electron 客户端 │                      │  Fastify + SDK  │
│ 语音/对话/工具  │                      │  多Agent/鉴权   │
│ 浏览器控制      │                      │  网关/密钥管理  │
└─────────────────┘                      └─────────────────┘
        ▲                                        ▲
        └── 3D 数字人 (three-vrm)、离线 ASR       └── 本地工具执行
```

---

## ✨ 核心特性

| 维度 | 能力 | 说明 |
|---|---|---|
| **实时协作** | 多会话 WebSocket、会话跟随指派、冲突处理 | 团队协作流：需求→研发→测试，状态机驱动 |
| **多 Agent 编排** | `assistant` / `coder` / `writer` 角色分离 | 各自独立工具集、技能包、权限边界 |
| **技能系统** | 插件化技能包自动发现、注入系统提示词 | 纯文档技能、SDK plugins/skills 挂载 |
| **本地工具执行** | Shell/文件/目录/浏览器控制、MCP 协议 | 服务端在本地会话里真跑命令、读写文件 |
| **离线语音** | sherpa-onnx Paraformer (ASR) + Windows SAPI (TTS) | 无网也能语音对话、关键词唤醒 |
| **3D 数字人** | three-vrm 驱动、口型同步、朝向修正 | VRM 模型加载、表情/动作分层 |
| **多用户隔离** | JWT 认证、用户级数据围栏、配额限流 | 网关层统管上游 LLM Key、单用户预算 |
| **可观测性** | 单用户/单模型统计、回合/预算双重熔断 | `MAX_TURNS` + `MAX_BUDGET_USD` 硬顶 |
| **安全基线** | 白名单默认拒绝、机密剥离、审批流 | `canUseTool` 非白即 deny、engineEnv 剥离 |

---

## 🚀 30 秒极速体验

### 前置要求
- Node.js ≥ 20
- Windows（离线 ASR/唤醒词/SAPI TTS 仅 Windows 已验证）

### 一键安装（推荐）
```powershell
# 1. 克隆
git clone https://github.com/lujianfu2008/xiaoqingting.git
cd xiaoqingting

# 2. 一键安装依赖 + 配置模板
npm run setup

# 3. 填入你的上游 Key（必填）
# 编辑 packages/server/.env：
#   ANTHROPIC_AUTH_TOKEN=sk-ant-xxx
#   ANTHROPIC_BASE_URL=https://api.anthropic.com
#   JWT_SECRET=你的强随机串
#   BLMA_USERNAME=admin / BLMA_PASSWORD=你的密码

# 4. 启动服务端
npm run dev:server
# → http://localhost:8788

# 5. 新终端启动桌面端
npm run dev:desktop
```

> 💡 Windows 用户也可直接双击 `start-all.bat`（已配置环境变量、最小化后台运行）

---

## 📦 离线 ASR 模型（可选，约 80 MB）

默认路径：`packages/desktop/models/sherpa-onnx-paramformer/`

```
packages/desktop/models/sherpa-onnx-paramformer/
├── model.int8.onnx    # 流式模型 (~79 MB)
├── tokens.txt
└── am.mvn
```

从 [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) 下载 `sherpa-onnx-paramformer-zh-small`，解压上述三个文件到位即可。

---

## 🏗️ 架构一览

| 包 | 职责 | 关键技术 |
|---|---|---|
| `@blm/protocol` | 共享类型契约、Zod 校验 | WS 消息、REST、任务、调度、工作流 |
| `@blm/server` | Fastify 服务端、Agent 管理、MCP 网关 | 多用户、鉴权、计费、技能注册表 |
| `@blm/desktop` | Electron 主/渲染进程、语音桥、3D 头像 | 本地 ASR/TTS、MCP 客户端、浏览器扩展 |

---

## 🛠️ 开发命令

```bash
npm run typecheck    # 协议层类型检查
npm run build        # 全包构建
```

---

架构约定（详见 `AGENTS.md`）：

## 📂 永不提交的内容（设计如此）

| 内容 | 位置 | 原因 |
|---|---|---|
| 服务端环境变量 | `packages/server/.env` | Key、管理员账号 — 见 `.env.example` |
| 数据目录 | `packages/server/data/` | 对话、用户、上游 Key |
| ASR 模型文件 | `packages/desktop/models/*.onnx` | 大二进制文件 |
| 构建产物 | `*.tgz` | npm 打包产物 |

---

## 📚 文档与实战复盘（持续更新）

| 文章 | 链接 | 核心价值 |
|---|---|---|
| 你的 WebSocket 为什么「假在线」？——僵尸连接翻车复盘 | [掘金](https://juejin.cn/post/7705621037035356160) | WS 可靠性四件套：心跳、僵尸清理、重连恢复、发送 ACK |
| 你的 AI 助手，可以自己发文、自己修 Bug、自己长大 | [掘金](https://juejin.cn/post/7705228164603527183) | 从 0 到 1 自动化发文管线：Puppeteer + 敏感词闸门 + 封面生成 |
| 定时任务中午挂了，下午重启，把上午的业务又全办了一遍 | [掘金](https://juejin.cn/post/7705330413946732559) | 幂等性三层防线：状态机前置、业务侧幂等键、独立对账 |

> 更多实战笔记见 `blog/` 目录。

---

## 🗺️ Roadmap（近期）

- [ ] Linux/macOS 离线 ASR 支持（sherpa-onnx 跨平台）
- [ ] 插件市场：技能包一键安装/更新/评分
- [ ] 企业版：审计日志、RBAC、私有化部署脚本
- [ ] 自建博客（Hugo + GitHub Pages）→ 海外 AdSense 长尾

---

## ☕ 赞助支持

如果这个项目帮到你，请考虑请作者喝杯咖啡 ☕

<p align="center">
  <a href="https://github.com/sponsors/lujianfu2008">
    <img src="https://img.shields.io/github/sponsors/lujianfu2008?style=for-the-badge&logo=github&logoColor=white&label=Sponsor&color=EA4AAA" alt="GitHub Sponsors" />
  </a>
  <br/>
  <img src="docs/sponsor/wechat.png" alt="WeChat 赞赏码" width="200" />
  <br/>
  <sub>微信赞赏码 / GitHub Sponsors 同款权益</sub>
</p>

---

## 📄 License

MIT © 2026 [lujianfu2008](https://github.com/lujianfu2008)

> **完全开源**：客户端、服务端、协议层全部代码均在本仓库公开，基于 MIT 协议，可自由使用、修改、商用与二次分发。
>
> 未入库的只有体积过大的模型权重（`.onnx`）与本机密钥配置（`.env`），见上方「永不提交的内容」。

---

## 🔗 English Version

[English README](./README.en.md)