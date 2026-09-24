# DeepSeek Gateway (ds2a) 部署与运维文档

本文档提供 **DeepSeek 智能网关** 的完整部署指南、配置说明及日常运维方案喵。

---

## 目录
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [部署方式](#部署方式)
  - [方式一：PM2 生产级守护进程（推荐）](#方式一pm2-生产级守护进程推荐)
  - [方式二：Docker / Docker Compose 部署](#方式二docker--docker-compose-部署)
  - [方式三：Windows PowerShell / Node.js 原生运行](#方式三windows-powershell--nodejs-原生运行)
- [核心配置说明](#核心配置说明)
- [账号与 Token 配置](#账号与-token-配置)
- [API 调用与对接指南](#api-调用与对接指南)
- [维护与日常运维](#维护与日常运维)

---

## 环境要求

- **Node.js**: `>= 18.0.0`
- **操作系统**: Windows / Linux / macOS
- **网络需求**: 能够正常访问 `https://chat.deepseek.com`
- **硬件消耗**: 内存 `< 100MB`，CPU 占用极低（得益于 WASM 硬件级加速与无浏览器设计）

---

## 快速开始

### 1. 克隆项目与安装依赖

```bash
git clone https://github.com/amnssb/ds2a.git
cd ds2a
npm install
```

### 2. 复制配置文件

```bash
# 复制环境变量配置
cp .env.example .env

# 复制账号配置文件示例
cp accounts.example.json data/accounts.json
```

---

## 部署方式

### 方式一：PM2 生产级守护进程（推荐）

适用于 Linux / Windows 生产环境，提供开机自启、故障自动重启与日志轮转喵。

```bash
# 全局安装 PM2（如已安装可跳过）
npm install -g pm2

# 使用配置文件启动网关
pm2 start ecosystem.config.js

# 查看服务运行状态
pm2 status

# 查看日志输出
pm2 logs ds-gateway

# 设置开机自启
pm2 startup
pm2 save
```

---

### 方式二：Docker / Docker Compose 部署

适用于容器化集群、Linux 云服务器或轻量 NAS 一键编排喵。

#### 使用 Docker Compose（推荐）

`docker-compose.yml` 已经内置了数据卷挂载、网络穿透与健康检查探测喵：

```bash
# 构建镜像并在后台启动服务
docker compose up -d --build

# 实时查看运行日志
docker compose logs -f

# 停止服务
docker compose down
```

> [!NOTE]
> **容器内代理穿透特性**：`docker-compose.yml` 已配置 `extra_hosts: ["host.docker.internal:host-gateway"]` 与 `DOCKER_CONTAINER=1` 环境变量喵。如果账号绑定的代理是宿主机上的本地代理（例如 `http://127.0.0.1:7890`），网关容器会自动映射至宿主机网关，避免连接拒绝喵。

#### 使用原生 Docker

```bash
# 构建镜像
docker build -t ds2a:latest .

# 启动容器并挂载数据目录
docker run -d \
  --name ds-gateway \
  -p 19728:19728 \
  --add-host=host.docker.internal:host-gateway \
  -e DOCKER_CONTAINER=1 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  --restart always \
  ds2a:latest
```

---

### 方式三：Windows PowerShell / Node.js 原生运行

#### 使用内置 PowerShell 管理脚本（Windows 推荐）

```powershell
# 启动后台进程
.\manage.ps1 start

# 查看状态与账号池情况
.\manage.ps1 status

# 连通性测试
.\manage.ps1 test

# 实时日志查看
.\manage.ps1 logs

# 重启 / 停止
.\manage.ps1 restart
.\manage.ps1 stop
```

#### 原生 Node.js 启动

```bash
# 直接启动服务端
node server.js
```

---

### 方式四：本机 Studio 启动（批量账号管理与代理池均分）

推荐在有图形界面的机器（如本地 Windows / macOS）上运行 Studio 负责账号管理与换 Token 喵：

```bash
# 启动本机账号 Studio
npm run studio
```

在浏览器打开 `http://127.0.0.1:19729/` 即可：
- 批量导入账号与代理列表（格式：`账号,邮箱,密码[,代理]` 或 JSON 数组）喵。
- 粘贴多行代理列表，一键将代理轮询均分给所有账号或选定账号喵。
- 调度本地 Chrome 自动执行有头/无头换 Token 任务喵。
- 换完后一键「上行同步」至远端服务器网关（19728 端口），服务端自动生效喵。

---

## 核心配置说明

环境变量或全局配置文件位于 `src/config.js` / `.env` 喵：

| 配置项 / 环境变量 | 默认值 | 说明 |
|-------------------|--------|------|
| `PORT` | `19728` | 网关监听端口喵 |
| `HOST` | `0.0.0.0` | 网关监听 IP 地址喵 |
| `DATA_DIR` | `./data` | 持久化数据存储路径喵 |
| `LOG_DIR` | `./logs` | 日志轮转存储路径喵 |
| `DEFAULT_PROXY` | `""` | 全局兜底代理（当账号未单独指定 proxy 时生效）喵 |
| `DOCKER_CONTAINER` | `0` | `1` 标识处于容器内，自动将 127.0.0.1 代理转映射至宿主机喵 |
| `POW_PREWARM_ENABLED` | `true` | 是否启用 PoW 0ms 滚动预热池喵 |
| `POW_PREWARM_CONCURRENCY` | `2` | 启动时多账号并发预热限制数喵 |
| `CIRCUIT_BREAKER_FAIL_LIMIT` | `3` | 账号连续失败触发熔断降级的次数喵 |

---

## 账号与 Token 配置

> **项目要求**：AI 测试时禁止传假 token 上去喵——测试必须使用真实有效 Token，禁止写入伪造 / 占位 / 过期假 Token，严禁将虚构测试账号写入项目文档喵。

### 1. 手动配置账号 (`data/accounts.json`)

打开 `data/accounts.json`，格式如下：

```json
[
  {
    "name": "acc1",
    "token": "YOUR_DEEPSEEK_USER_TOKEN_HERE",
    "email": "user@example.com",
    "password": "your_password_optional",
    "proxy": "http://127.0.0.1:7890",
    "disabled": false
  }
]
```

- **`proxy` 字段说明**：
  - 支持协议：`http://`、`https://`、`socks5://`、`socks5h://` 喵。
  - 支持带账密格式：`http://username:password@ip:port` 或 `socks5://user:pass@ip:port` 喵。
  - 绑定后，该账号的所有请求、PoW 计算与换 Token 将独占该出口 IP 喵。

### 2. 获取 `userToken` 方法

1. 打开浏览器并登录 [chat.deepseek.com](https://chat.deepseek.com)。
2. 按 `F12` 打开开发者工具，切换到 **Console (控制台)**。
3. 执行以下命令获取 Token：
   ```javascript
   JSON.parse(localStorage.getItem('userToken')).value
   ```
4. 将复制出的 Token 字符串粘贴至配置文件或 Web 控制台喵。

---

## API 调用与对接指南

网关完全兼容 **OpenAI** 和 **Claude** 官方接口格式，可无缝接入各种第三方客户端喵。

### 1. OpenAI 格式端点 (`POST /v1/chat/completions`)

```bash
curl http://127.0.0.1:19728/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ],
    "thinking": true,
    "stream": true
  }'
```

### 2. Claude 格式端点 (`POST /v1/messages`)

```bash
curl http://127.0.0.1:19728/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "claude-3-5-sonnet",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### 3. Web Dashboard 管理后台

在浏览器打开：`http://127.0.0.1:19728/panel/`
- **默认管理员账号**：`admin`
- **默认管理员密码**：`admin123`

在此面板中可以实时查看账号健康度、连通性探测、在线配置 API Key 以及查看持久化统计图表喵。

---

## 维护与日常运维

1. **账号熔断恢复**：若账号状态变为 `🔴 异常已暂停`，说明 Token 已过期（报 40003）。可在管理后台更新 Token 后点击 **一键测试/恢复**。
2. **日志安全与自动滚动**：日志已接入异步缓冲与自动切割机制（超 50MB 自动切割），不占用过多磁盘空间。
3. **数据安全**：所有核心配置与监控统计文件均保存在 `data/` 目录中，支持热备份与迁移喵。
