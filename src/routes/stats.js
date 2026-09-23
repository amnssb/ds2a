'use strict';
/**
 * src/routes/stats.js — 系统健康、持久化统计与请求日志查询路由
 */
const express = require('express');
const storage = require('../storage');
const accountPool = require('../account-pool');
const powEngine = require('../pow-engine');
const config = require('../config');
const { requireAdmin } = require('./keys');

const router = express.Router();

// 健康检查接口（唯一实现；server.js 不再重复挂载）
router.get('/health', (req, res) => {
    const snap = accountPool.snapshot();
    const healthyCount = snap.filter(a => a.healthy).length;
    const { sessions } = require('./chat');
    res.json({
        status: healthyCount > 0 ? 'ok' : 'degraded',
        healthyAccounts: healthyCount,
        totalAccounts: snap.length,
        wasmAcceleration: powEngine.isWasmReady(),
        sessionsCount: sessions ? sessions.size : 0,
        accounts: snap,
    });
});

// 统计大盘数据（持久化，重启不丢失；面板登录后可见）
router.get('/v1/stats', requireAdmin, (req, res) => {
    const poolSnap = accountPool.snapshot();
    const totalInflight = poolSnap.reduce((s, a) => s + (a.inflight || 0), 0);
    const poolSummary = {
        accounts: poolSnap.length,
        healthy: poolSnap.filter(a => a.healthy).length,
        healthyAccounts: poolSnap.filter(a => a.healthy).length,
        paused: poolSnap.filter(a => a.state === 'paused' || a.state === 'auth_failed').length,
        cooldown: poolSnap.filter(a => a.state === 'cooldown').length,
        totalInflight,
        wasmAcceleration: powEngine.isWasmReady(),
    };
    const snap = storage.getSnapshot(poolSummary);
    snap.accounts = poolSnap;
    snap.pool = Object.assign({}, snap.pool, poolSummary);
    snap.wasmAcceleration = powEngine.isWasmReady();
    const { sessions } = require('./chat');
    snap.pool.activeSessions = sessions ? sessions.size : 0;
    res.json(snap);
});

// 详细历史请求日志（支持多维度筛选，需管理员登录）
router.get('/api/logs', requireAdmin, (req, res) => {
    const filterStatus = req.query.status; // 'ok' | 'err' | 'all'
    const filterAccount = req.query.account;
    const limit = Math.min(Number(req.query.limit || 50), 200);

    let list = storage.recent;
    if (filterStatus === 'ok') list = list.filter(x => x.ok);
    else if (filterStatus === 'err') list = list.filter(x => !x.ok);

    if (filterAccount) list = list.filter(x => x.account === filterAccount);

    res.json({
        total: list.length,
        logs: list.slice(0, limit),
    });
});

module.exports = router;
