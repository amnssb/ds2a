# DeepSeek Gateway 容器化与服务器部署指南

## 容器化部署概述

本网关提供全套容器化解决方案，支持 Docker 与 Docker Compose，具备轻量（Alpine Linux）、高并发（WASM 硬件加速）、数据零丢失（持久化卷挂载）等生产级特性。

---

## 快速开始（一键容器部署）

### 1. 准备环境变量与配置
在项目根目录下，复制模板生成 `.env`：
```bash
cp .env.example .env
```
主要变量说明：
| 变量名 | 默认值 | 作用说明 |
|---|---|---|
| `PORT` | `34868` | 映射到宿主机的 HTTP 端口 |
| `HOST` | `0.0.0.0` | 容器内绑定地址 |
| `DS_ADMIN_USER` | `admin` | 管理控制台用户名 |
| `DS_ADMIN_PASS` | `admin` | 管理控制台初始密码 |
| `DS_REQUIRE_KEY` | `false` | 是否强制外部客户端携带 API Key |
| `DS_POW_PREWARM` | `true` | 是否开启 PoW 异步预热池（0ms 响应） |

### 2. 启动容器

**Linux / macOS 用户：**
```bash
./docker-manage.sh up
```

**Windows PowerShell 用户：**
```powershell
.\docker-manage.ps1 up
```

**或者使用原生 Docker Compose 命令：**
```bash
docker compose up -d --build
```

---

## 常用容器运维命令

| 操作 | Linux / macOS | Windows PowerShell | Docker 原生命令 |
|---|---|---|---|
| 启动并后台运行 | `./docker-manage.sh up` | `.\docker-manage.ps1 up` | `docker compose up -d` |
| 查看运行状态与健康度 | `./docker-manage.sh status` | `.\docker-manage.ps1 status` | `docker compose ps` |
| 实时跟踪输出日志 | `./docker-manage.sh logs` | `.\docker-manage.ps1 logs` | `docker compose logs -f --tail 100` |
| 重启容器 | `./docker-manage.sh restart` | `.\docker-manage.ps1 restart` | `docker compose restart` |
| 停止并销毁容器 | `./docker-manage.sh down` | `.\docker-manage.ps1 down` | `docker compose down` |
| 重新构建无缓存镜像 | `./docker-manage.sh build` | `.\docker-manage.ps1 build` | `docker compose build --no-cache` |

---

## 数据持久化挂载结构

容器运行时将宿主机目录挂载至容器内部，确保配置文件、历史请求流水、Token 统计与日志在容器重启或重新构建后完全保留：

```text
宿主机目录 (D:\... 或 /opt/ds-browserless/)
├── data/              <---> 容器内 /app/data
│   ├── accounts.json        (账号列表与熔断状态)
│   ├── auth-data.json       (管理员会话与 API Key)
│   ├── stats.json           (历史聚合用量与 Token 指标)
│   └── requests.jsonl       (持久化请求明细流水)
└── logs/              <---> 容器内 /app/logs
    ├── server.log           (主服务运行日志)
    └── server.err.log       (异常告警日志)
```

---

## 生产环境安全与健康检查

1. **非 root 用户运行**：Dockerfile 使用 Node 官方 `node` 用户运行进程，避免容器逃逸风险。
2. **tini 进程生命周期托管**：容器内部使用 `tini` 作为 PID 1 入口，确保 `SIGTERM` 信号正确通知 Node.js 保存统计数据落盘并安全退出。
3. **原生健康检查 (HealthCheck)**：每 20 秒探测一次 `http://127.0.0.1:34868/health`，一旦服务异常或所有账号故障，Docker 将标记状态为 `unhealthy`。
4. **日志滚动与内存限制**：Compose 配置了最大 20MB * 5 的日志滚动轮替策略，并对内存限制为 512MB，适合 1G~2G 低配云服务器运行。
