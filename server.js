'use strict';
/**
 * server.js — DeepSeek 高性能企业级网关服务入口
 * 架构特点：
 *  - 模块化规范清晰 (src/config, src/storage, src/account-pool, src/pow-engine, src/routes)
 *  - 完整兼容 OpenAI (/v1/chat/completions) 与 Claude (/v1/messages)
 *  - 文件上传 (/v1/files) 与多轮会话管理 (/v1/sessions) 完整支持
 *  - WASM 硬件级加速 + 预热 PoW 缓存池
 *  - 智能熔断自愈与无感故障转移 (Failover)
 *  - 严格安全规范：数据持久化统一保存在非 C 盘 (D 盘空间)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const config = require('./src/config');
const logger = require('./src/logger');
const storage = require('./src/storage');
const accountPool = require('./src/account-pool');
const powEngine = require('./src/pow-engine');
const auth = require('./src/auth');

const { router: chatRouter } = require('./src/routes/chat');
const filesRouter = require('./src/routes/files');
const sessionsRouter = require('./src/routes/sessions');
const accountsRouter = require('./src/routes/accounts');
const statsRouter = require('./src/routes/stats');
const { router: keysRouter, requireAdmin } = require('./src/routes/keys');

const app = express();

// 1. 基础中间件
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        // 过滤高频轮询的 stats 日志，避免刷屏
        if (req.url !== '/v1/stats' && req.url !== '/health') {
            logger.http(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - start}ms)`);
        }
    });
    next();
});

// JSON 解析中间件
app.use(express.json({ limit: `${config.MAX_UPLOAD_MB + 5}mb` }));

// Cookie 解析中间件
app.use((req, res, next) => {
    const raw = req.headers.cookie || '';
    req.cookies = {};
    for (const p of raw.split(';')) {
        const i = p.indexOf('=');
        if (i > 0) req.cookies[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    }
    next();
});

// CORS 跨域放行
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-session-id, x-conversation-id');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// 2. 静态控制台面板 (panel)
app.use('/panel', express.static(config.PANEL_DIR));
app.get('/', (req, res) => res.redirect('/panel/'));

// 3. 核心路由挂载
app.use(filesRouter);
app.use(chatRouter);
app.use(sessionsRouter);
app.use(keysRouter);
app.use(statsRouter);
app.use(accountsRouter);

// 4. 健康检查由 src/routes/stats.js 统一提供（避免重复挂载）喵

// 5. 404 与全局错误处理
app.use((req, res, next) => {
    if (res.headersSent) return;
    res.status(404).json({ error: 'Not Found: ' + req.url });
});

app.use((err, req, res, next) => {
    logger.err('全局未捕获异常: ' + (err.stack || err.message));
    if (!res.headersSent) {
        res.status(500).json({
            error: {
                message: err.message || '服务内部错误喵',
                type: 'internal_server_error',
            },
        });
    }
});

// 6. 优雅停机钩子
function setupGracefulShutdown(serverInstance) {
    const shutdown = (signal) => {
        logger.warn(`收到 ${signal} 信号，正在保存数据并优雅停机...`);
        storage.flushSync();
        auth.flush();
        serverInstance.close(() => {
            logger.ok('服务已安全退出。');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 3000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 7. 启动服务监听
const server = app.listen(config.PORT, config.HOST, () => {
    const displayHost = config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST;
    logger.ok(`🚀 DeepSeek 智能网关已启动（端口: ${config.PORT}，监听: ${config.HOST}）`);
    logger.info(`OpenAI 接口:  http://${displayHost}:${config.PORT}/v1/chat/completions`);
    logger.info(`Claude 接口:  http://${displayHost}:${config.PORT}/v1/messages`);
    logger.info(`文件上传:     http://${displayHost}:${config.PORT}/v1/files`);
    logger.info(`管理控制台:   http://${displayHost}:${config.PORT}/panel/`);
    logger.info(`健康状态:     http://${displayHost}:${config.PORT}/health`);
    logger.info(`WASM 硬件加速: ${powEngine.isWasmReady() ? '已启用 (85ms/10万次)' : '未启用 (纯 JS 兜底)'}`);
    logger.info(`数据持久化:   ${config.DATA_DIR}`);

    // 预热：为每个健康账号填满 PoW 滚动池
    if (config.POW_PREWARM_ENABLED) {
        const ds = require('./src/ds-client');
        const healthyAccs = accountPool.accounts.filter(a => a.token && !a.disabled && !a.paused);
        const concurrency = config.POW_PREWARM_CONCURRENCY || 2;

        async function prewarmAccount(acc) {
            const fills = Array.from({ length: powEngine.POW_POOL_MAX },
                // 必须带上账号独立代理：PoW 池按 token+proxy 作为缓存键，缺了 proxy 会导致预热永远无法命中
                () => ds.prewarmPoW(acc.token, undefined, acc.proxy || '').catch(() => {}));
            await Promise.all(fills);
        }

        let running = 0, idx = 0;
        function runNext() {
            while (running < concurrency && idx < healthyAccs.length) {
                running++;
                const acc = healthyAccs[idx++];
                prewarmAccount(acc).finally(() => { running--; runNext(); });
            }
        }
        runNext();
    }
});

// 解除 Node.js HTTP 默认请求超时（默认 5 分钟），保证超长思考与大吞吐流式不被网关强制掐断
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 65000;

setupGracefulShutdown(server);

module.exports = app;