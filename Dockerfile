# ==========================================
# 阶段 1: 依赖安装与构建
# ==========================================
# 服务器拉不到 docker.io 时可用本地基础镜像: --build-arg NODE_IMAGE=ds-node-base:20
ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE} AS deps
# 本地离线 base 可能继承 USER node，构建阶段必须 root
USER root
WORKDIR /app

# 国内/受限网络：apk 源切到清华镜像
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories || true

COPY package*.json ./
RUN npm install --omit=dev --no-audit --ignore-scripts

# ==========================================
# 阶段 2: 生产运行镜像
# ==========================================
FROM ${NODE_IMAGE} AS runner
USER root
WORKDIR /app

# 安装 tini 实现精确的进程生命周期与信号传递（保障容器停机时数据落盘）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories || true
RUN apk add --no-cache tini tzdata curl \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=19728

# 创建持久化数据与日志挂载目录并赋予 node 用户权限
RUN mkdir -p /app/data /app/logs /app/vendor && chown -R node:node /app

# 从依赖构建阶段复制 node_modules
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# 切换为非 root 安全用户运行
USER node

# 容器持久化卷
VOLUME ["/app/data", "/app/logs"]

# 对外暴露服务端口
EXPOSE 19728

# 原生健康检查探测
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:19728/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
