'use strict';
/**
 * src/routes/stats.js — 系统健康、持久化统计与请求日志查询路由
 */
const express = require('express');
const storage = require('../storage');
const accountPool = require('../account-pool');
const powEngine = require('../pow-engine');
const config = require('../config');

const router = express.Router();

// 健康检查接口
router.get('/health', (req, res) => {
    const snap = accountPool.snapshot();
    const healthyCount = snap.filter(a => a.healthy).length;
    res.json({
        status: healthyCount > 0 ? 'ok' : 'degraded',
        healthyAccounts: healthyCount,
        totalAccounts: snap.length,
        wasmAcceleration: powEngine.isWasmReady(),
        accounts: snap,
    });
});

// 统计大盘数据（持久化，重启不丢失）
router.get('/v1/stats', (req, res) => {
    const poolSnap = accountPool.snapshot();
    const poolSummary = {
        accounts: poolSnap.length,
        healthy: poolSnap.filter(a => a.healthy).length,
        paused: poolSnap.filter(a => a.state === 'paused' || a.state === 'auth_failed').length,
        cooldown: poolSnap.filter(a => a.state === 'cooldown').length,
        wasmAcceleration: powEngine.isWasmReady(),
    };
    const snap = storage.getSnapshot(poolSummary);
    snap.accounts = poolSnap;
    res.json(snap);
});

// 详细历史请求日志（支持多维度筛选）
router.get('/api/logs', (req, res) => {
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
