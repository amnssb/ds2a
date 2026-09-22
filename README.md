# DeepSeek Gateway (企业级无浏览器高性能网关)

把 chat.deepseek.com 转换为原生 **OpenAI / Claude 兼容 API**。
**彻底无需浏览器**，直接走 DeepSeek 原生 HTTP + 官方 WebAssembly 算法，在极低硬件资源下实现高并发、毫秒级响应。

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
- **账号调度中心**：支持一键连通性探测、手动暂停/恢复、自动重登、实时并发负载展示。
- **日志审计面板**：支持按成功/失败过滤历史请求，实时查看失败堆栈与诊断信息。
- **Token 资产大盘**：日度消耗曲线与各账号配额分析。

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
│   ├── ds-client.js       # KeepAlive 原生 HTTP 客户端与 SSE 解析器
│   ├── auth.js            # 管理员会话与 API Key 鉴权模块
│   └── routes/
│       ├── chat.js        # OpenAI / Claude 兼容对话端点
│       ├── accounts.js    # 账号 CRUD 与状态测试路由
│       ├── stats.js       # 监控大盘与持久日志查询
│       └── keys.js        # API Key 管理路由
├── data/                  # 持久化数据目录
│   ├── accounts.json      # 账号凭据与调度状态
│   ├── auth-data.json     # 管理员凭证与 API Key 数据
│   ├── stats.json         # 累计统计数据（重启恢复）
│   └── requests.jsonl     # 请求流水日志（追加流）
├── logs/                  # 运行时日志目录
│   ├── server.log
│   └── server.err.log
├── vendor/                # 官方 sha3_wasm_bg.wasm 核心
├── panel/                 # 响应式管理后台
├── server.js              # 工业级应用入口
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
# 一键编译与启动
docker-compose up -d

# 查看日志
docker-compose logs -f
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

- **Q: 账号显示 `🔴 异常已暂停` 如何处理？**
  - 说明该账号的 userToken 已被官方判定失效（报 `40003 invalid token`）。
  - 登录 [chat.deepseek.com](https://chat.deepseek.com) 控制台，按 F12 执行 `JSON.parse(localStorage.getItem('userToken')).value` 获取新 Token，在后台面板编辑更新即可立即恢复。
- **Q: 多账号调度是如何轮询的？**
  - 系统使用最小负载优先调度。遇到异常账号立刻自动跳过，并顺延至下一可用账号，避免单账号故障影响整体业务。
