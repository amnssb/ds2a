# DeepSeek Gateway (企业级无浏览器高性能网关)

把 chat.deepseek.com 转换为原生 **OpenAI / Claude 兼容 API**。
**彻底无需浏览器**，直接走 DeepSeek 原生 HTTP + 官方 WebAssembly 算法，在极低硬件资源下实现高并发、毫秒级响应。

---

## 项目要求

- **AI 测试时禁止传假 token 上去**：进行 AI / 联通性 / 自动化测试时，必须使用真实有效账号 Token，禁止提交、上传或注入伪造 / 占位 / 过期假 Token，避免污染 `data/accounts.json` 与线上调度池喵。

---

## 核心技术特性

### 1. 异常熔断与智能故障隔离 (Circuit Breaker & Failover)
- **Token 失效即停**：当账号遇到 `40003 invalid token` 或鉴权失效时，系统**立刻将该账号标记为熔断并暂停调度**，避免无效重试导致 IP 被官方风控。
- **无感故障转移 (Failover)**：配置多账号时，某个账号若异常，网关自动将请求无缝移交给下一个可用账号，调用方客户端完全无感知。
- **自动自愈机制**：对于配置了密码的账号，系统在后台异步调用自动登录更新 Token，换取成功后自动恢复调度。
- **状态可视化**：控制台提供 `🟢 正常`、`🟡 冷却中`、`🔴 异常已暂停`、`⚪ 已禁用` 状态看板，支持一键连通性测试与手动恢复。

### 2. 低硬件配置深度性能优化 (WASM 40x 加速 + 预热池)
- **WASM 硬件级哈希**：官方 `sha3_wasm_bg.wasm` 算法全量接入，在 100,000 难度下 PoW 求解耗时由纯 JS 的 **3500ms 降至 85ms（提速超 40 倍）**。
- **0ms 延迟预热池**：系统在空闲时为活跃账号预先计算 PoW 令牌并存入预热池，并发请求命中预热时直接放行，**PoW 等待耗时直降为 0ms**。
- **非阻塞事件循环**：消除主线程 CPU 密集计算阻塞，保障高并发下的 SSE 流式打字机不卡顿、不丢字。
- **Keep-Alive 连接池复用**：长连接全局复用，免去并发场景下反复建立 TLS 握手的网络开销。

### 3. 数据持久化存储 (重启零丢失)
- **非 C 盘安全落盘**：严格遵循安全设计，所有配置、日志、统计均写入 `data/` 和 `logs/` 目录，禁止占用系统 C 盘。
- **持久化请求流水**：`data/requests.jsonl` 记录每一次调用的端点、耗时、状态码、输入/输出 Token、账号、错误原因，服务重启后历史日志与统计图表完整保留。
- **全局 Token 计量**：持久化按天、按账号、按 API Key 统计 Prompt / Completion / Thinking Token 用量。

### 4. 增强型现代控制台 (Web Dashboard)
- 访问：`http://127.0.0.1:19728/panel/`（默认凭证：`admin` / `admin123`）。
- **账号调度中心**：支持一键连通性探测、手动暂停/恢复、代理配置与批量分配、实时并发负载展示喵。
- **日志审计面板**：支持按成功/失败过滤历史请求，实时查看失败堆栈与诊断信息喵。
- **Token 资产大盘**：日度消耗曲线与各账号配额分析喵。

### 5. 账号级独立代理与代理池均分 (Per-Account Dedicated Proxy)
- **多协议原生支持**：全面支持 `http://`、`https://`、`socks5://` 及 `socks5h://` 协议，原生支持带账号密码的代理认证喵。
- **全链路出口 IP 彻底隔离**：每个账号配置的独立代理严格贯穿该账号的所有对话请求、PoW 挑战求解与浏览器换 Token 流程，彻底解决多账号同 IP 串流风控痛点喵。
- **代理池一键均分绑定**：支持在控制台与 Studio 中直接粘贴多行代理列表，一键将代理轮询均分给全部账号或勾选账号，支持一键清空与单账号快速编辑喵。
- **Docker 容器环境智能兼容**：容器内自动解析 `host.docker.internal`，填入 `127.0.0.1:7890` 的宿主机本地代理可自动重定向至宿主机网关，跨容器及公网代理亦原生直连生效喵。

### 6. 本机 Studio 与服务端网关双层协同架构
- **本机 Studio (`http://127.0.0.1:19729/`)**：在本机安全维护账号敏感凭证与代理池，利用本地 Chrome 浏览器实现稳定自动换 Token，并一键无缝推送到远端服务器喵。
- **服务端网关 (`http://127.0.0.1:19728/`)**：轻量化生产部署，无需安装浏览器依赖，专注于高并发纯 HTTP 分发、WASM 硬件级哈希计算与异常熔断 Failover 调度喵。

---

## 目录架构

```text
ds-browserless/
├── src/
│   ├── config.js          # 全局配置中心（安全路径校验，杜绝 C 盘写入）
│   ├── logger.js          # 双通道日志记录（终端高亮 + 滚动持久化日志）
│   ├── storage.js         # 运行时数据与历史请求持久化引擎
│   ├── pow-engine.js      # WASM 求解器 + 纯 JS 容灾兜底 + 预热池
│   ├── account-pool.js    # 账号状态机、熔断隔离与 Failover 调度器
│   ├── ds-client.js       # KeepAlive 原生 HTTP 客户端、SOCKS5 连接器与 SSE 解析器
│   ├── ds-login.js        # Chrome / CDP 自动登录与 Token 刷新引擎
│   ├── auth.js            # 管理员会话与 API Key 鉴权模块
│   └── routes/
│       ├── chat.js        # OpenAI / Claude 兼容对话端点
│       ├── accounts.js    # 账号 CRUD、状态测试与 Studio 同步路由
│       ├── stats.js       # 监控大盘与持久日志查询
│       └── keys.js        # API Key 管理路由
├── studio/                # 本机账号管理与换 Token 工作台
│   ├── server.js          # Studio 服务端 (19729 端口)
│   ├── store.js           # 本地账号存储与状态镜像
│   ├── jobs.js            # 批量换 Token 与上行任务处理
│   ├── remote.js          # 服务端通信与状态同步客户端
│   └── public/index.html  # Studio 可视化界面 (支持代理均分与弹窗编辑)
├── data/                  # 持久化数据目录
│   ├── accounts.json      # 账号凭据、独立代理与调度状态
│   ├── auth-data.json     # 管理员凭证与 API Key 数据
│   ├── stats.json         # 累计统计数据（重启恢复）
│   └── requests.jsonl     # 请求流水日志（追加流）
├── logs/                  # 运行时日志目录
│   ├── server.log
│   └── server.err.log
├── vendor/                # 官方 sha3_wasm_bg.wasm 核心
├── panel/                 # 响应式管理后台 (含代理分配)
├── server.js              # 网关服务端入口
├── manage.ps1             # Windows 综合运维管理脚本
├── ecosystem.config.js    # PM2 生产环境配置文件
├── Dockerfile             # 容器构建镜像
└── docker-compose.yml     # 一键编排容器部署
```

---

## 部署与运维

### 方式一：Windows PowerShell 管理脚本（推荐）

```powershell
# 启动网关
.\manage.ps1 start

# 查看运行状态与账号池健康情况
.\manage.ps1 status

# 发送测试 Prompt 验证连通性
.\manage.ps1 test

# 实时查看服务端运行日志
.\manage.ps1 logs

# 重启或停止
.\manage.ps1 restart
.\manage.ps1 stop
```

### 方式二：PM2 生产级守护进程

```bash
# 启动并托管
pm2 start ecosystem.config.js

# 查看日志与监控
pm2 logs ds-gateway
pm2 monit
```

### 方式三：Docker / Docker Compose

```bash
# 构建并后台启动网关服务（支持自动映射宿主机代理 host.docker.internal）
docker compose up -d --build

# 查看运行日志与健康状态
docker compose logs -f
```

### 方式四：本机 Studio 启动（账号管理与换 Token）

```bash
# 启动本机账号 Studio
npm run studio
# 随后在浏览器访问 http://127.0.0.1:19729/ 即可进行可视化管理与代理均分喵
```

---

## API 调用示例

### 1. OpenAI 格式兼容 (`POST /v1/chat/completions`)

```bash
curl http://127.0.0.1:19728/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "你好，请介绍一下你自己"}],
    "thinking": true,
    "stream": true
  }'
```

### 2. Claude 格式兼容 (`POST /v1/messages`)

```bash
curl http://127.0.0.1:19728/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

---

## 常见问题排查

- **Q: 如何为每个账号配置独立固定代理？**
  - 在本机 Studio（`19729` 端口）中，可以在表格「代理 (Proxy)」列直接点击「+配代理 / 改」单独配置，也可以在顶部的「⚡ 账号分代理管理」卡片中粘贴多行代理列表一键均分绑定喵。
  - 在服务端控制台（`19728` 端口）的「账号调度管理」中，也可点击右上角「⚡ 批量分配代理」或行内「编辑账号」进行绑定喵。
- **Q: 容器内如何使用宿主机上的本地代理（如 Clash 7890）？**
  - 容器环境已集成 `extra_hosts` 映射与代码级自动转换逻辑，即使在账号代理中填写 `http://127.0.0.1:7890`，网关在容器内会自动重写为 `http://host.docker.internal:7890` 访问宿主机网关，无需手动调整 IP 喵。
- **Q: 账号显示 `🔴 异常已暂停` 如何处理？**
  - 说明该账号的 userToken 已被官方判定失效（报 `40003 invalid token`）喵。
  - 可以在本机 Studio 点击「批量换 Token」全自动刷新，或者在控制台编辑更新 Token 后点击「连通测试」恢复调度喵。
- **Q: 多账号调度是如何轮询的？**
  - 系统使用负载与健康度优先调度策略喵。遇到异常账号立刻自动隔离并无缝重试下一个健康账号，调用方无感且互不串号喵。
