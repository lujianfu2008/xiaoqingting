# 白龙马智能体 — 服务端镜像
# 构建镜像（在仓库根目录）:
#   docker build -f deploy/Dockerfile -t bailongma-server .
# 运行:
#   docker run -d --name blm -p 8788:8788 \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -e JWT_SECRET=change-me \
#     -e BLMA_USERNAME=admin -e BLMA_PASSWORD=change-me \
#     -v blm-data:/app/packages/server/data \
#     bailongma-server

FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN npm install --workspaces --include-workspace-root \
      --workspace @blm/protocol --workspace @blm/server

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/server packages/server

ENV PORT=8788 \
    DATA_DIR=/app/packages/server/data

EXPOSE 8788

WORKDIR /app/packages/server
CMD ["npx", "tsx", "src/index.ts"]
