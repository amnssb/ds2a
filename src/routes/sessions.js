'use strict';
/**
 * src/routes/sessions.js — 多轮会话管理接口 (/v1/sessions)
 */
const express = require('express');
const { sessions } = require('./chat');
const accountPool = require('../account-pool');
const ds = require('../ds-client');
const { requireAdmin } = require('./keys');
const logger = require('../logger');

const router = express.Router();

// 1. 获取当前活跃的多轮会话列表
router.get('/v1/sessions', requireAdmin, (req, res) => {
    const now = Date.now();
    const list = [...sessions.entries()].map(([key, v]) => ({
        session: key,
        account: v.accName,
        sid: v.sid,
        parent: v.parent,
        idleSec: Math.round((now - v.lastUsed) / 1000),
        lastUsedAt: v.lastUsed,
    }));
    res.json({ sessions: list });
});

// 2. 删除指定会话并向 DeepSeek 发送释放请求
router.delete('/v1/session/:key', requireAdmin, async (req, res) => {
    const k = decodeURIComponent(req.params.key);
    const v = sessions.get(k);
    let deleted = false;
    if (v) {
        sessions.delete(k);
        deleted = true;
        const acc = accountPool.accounts.find(a => a.token === v.token);
        if (acc) {
            ds.deleteSession(v.token, v.sid, v.proxy || '').catch(() => {});
        }
        logger.info(`会话 ${k} [sid: ${v.sid.slice(0, 8)}] 已主动释放`);
    }
    res.json({ ok: true, deleted });
});

module.exports = router;
