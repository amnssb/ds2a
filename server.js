'use strict';
/**
 * server.js — DeepSeek 高性能网关服务入口
 * 架构重构升级：
 *  - 模块化组织 (src/config, src/storage, src/account-pool, src/pow-engine, src/routes)
 *  - 异常自动熔断与暂停调度 (遇 40003 invalid token 立刻暂停，多账号无感 Failover)
 *  - WASM 硬件加速 (耗时从 3500ms 降至 85ms，提速 40x，多并发流畅运行)
 *  - 数据永久持久化 (日志与 Token 记录实时落盘，服务重启数据不丢失)
 *  - 严格安全规范 (禁止落盘 C 盘，统一托管至 D 盘项目空间)
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

const chatRouter = require('./src/routes/chat');
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

// 3. 文件上传缓冲区
const uploadBuffers = new Map();
const UPLOAD_TTL_MS = 30 * 60 * 1000; // 30 分钟未取用则自动回收

// 定期清理过期上传缓冲（防内存泄漏）
const _uploadGC = setInterval(() => {
    const now = Date.now();
    for (const [id, f] of uploadBuffers) {
        if (now - f.at > UPLOAD_TTL_MS) uploadBuffers.delete(id);
    }
}, 5 * 60 * 1000);
if (_uploadGC.unref) _uploadGC.unref();

app.post('/v1/files', (req, res) => {
    const b = req.body || {};
    if (b && b.data) {
        const buf = Buffer.from(String(b.data).replace(/^data:[^;]+;base64,/, ''), 'base64');
        const fid = 'f_' + crypto.randomBytes(8).toString('hex');
        uploadBuffers.set(fid, {
            id: fid,
            name: b.name || 'upload.bin',
            mime: b.mime || 'application/octet-stream',
            data: buf.toString('base64'),
            size: buf.length,
            at: Date.now(),
        });
        return res.json({ ok: true, file: { id: fid, name: b.name || 'upload.bin', size: buf.length } });
    }
    res.status(400).json({ error: '请以 JSON 格式提供 {name, mime, data(base64)}' });
});
app.get('/v1/files', (req, res) => res.json({ files: [...uploadBuffers.values()].map(f => ({ id: f.id, name: f.name, size: f.size, at: f.at })) }));
app.delete('/v1/files/:id', (req, res) => res.json({ ok: uploadBuffers.delete(req.params.id) }));

// 4. 路由注册
app.use(chatRouter);
app.use(keysRouter);
app.use(statsRouter);
app.use(accountsRouter);

// 5. 全局错误捕获
app.use((err, req, res, next) => {
    logger.err('全局未捕获异常: ' + err.stack);
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
function setupGracefulShutdown(server) {
    const shutdown = (signal) => {
        logger.warn(`收到 ${signal} 信号，正在保存数据并优雅停机...`);
        storage.flushSync();
        auth.flush();
        server.close(() => {
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
    logger.ok('🚀 DeepSeek 智能网关已启动（工业级优化版）');
    logger.info(`OpenAI 接口:  http://${config.HOST}:${config.PORT}/v1/chat/completions`);
    logger.info(`Claude 接口:  http://${config.HOST}:${config.PORT}/v1/messages`);
    logger.info(`管理控制台:   http://${config.HOST}:${config.PORT}/panel/`);
    logger.info(`健康状态:     http://${config.HOST}:${config.PORT}/health`);
    logger.info(`WASM 硬件加速: ${powEngine.isWasmReady() ? '已启用 (85ms/10万次)' : '未启用 (纯 JS 兜底)'}`);
    logger.info(`数据持久化:   ${config.DATA_DIR}`);

    // 预热：为每个健康账号填满 PoW 滚动池（并发受控，最多同时处理 POW_PREWARM_CONCURRENCY 个账号）
    if (config.POW_PREWARM_ENABLED) {
        const ds = require('./src/ds-client');
        const healthyAccs = accountPool.accounts.filter(a => a.token && !a.disabled && !a.paused);
        const concurrency = config.POW_PREWARM_CONCURRENCY || 2;

        // 为单个账号填满预热池（并发发 POW_POOL_MAX 个请求，prewarmPoW 内部幂等去重）
        async function prewarmAccount(acc) {
            const fills = Array.from({ length: powEngine.POW_POOL_MAX },
                () => ds.prewarmPoW(acc.token).catch(() => {}));
            await Promise.all(fills);
        }

        // 信号量：最多同时对 concurrency 个账号并发预热
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

setupGracefulShutdown(server);

module.exports = app;