'use strict';
/**
 * src/routes/accounts.js — 账号管理路由（增删改查、状态管理、一键测试、恢复/暂停、登录）
 */
const express = require('express');
const accountPool = require('../account-pool');
const ds = require('../ds-client');
const logger = require('../logger');
const { requireAdmin } = require('./keys');

const router = express.Router();

// 全部账号管理接口需管理员登录（防未授权读取明文密码/Token）
router.use('/api/accounts', requireAdmin);

// 获取账号列表（含健康状态、熔断状态与错误信息）
// ?reveal=1 返回明文 token/password，仅登录后可用
router.get('/api/accounts', (req, res) => {
    const reveal = req.query.reveal === '1';
    const poolList = accountPool.accounts;
    const rawList = accountPool.readRaw();
    const list = rawList.map((a, i) => {
        const poolAcc = poolList[i] || poolList.find(p => p.name === (a.name || ('acc' + (i + 1))));
        return {
            index: i,
            name: a.name || ('acc' + (i + 1)),
            email: a.email || '',
            mobile: a.mobile || '',
            areaCode: a.areaCode || '+86',
            token: reveal ? (a.token || '') : (a.token ? (a.token.slice(0, 6) + '…' + a.token.slice(-4)) : ''),
            hasToken: !!a.token,
            password: reveal ? (a.password || '') : (a.password ? '******' : ''),
            hasPassword: !!a.password,
            autoLogin: a.autoLogin !== false,
            disabled: !!a.disabled,
            paused: !!(poolAcc ? poolAcc.paused : a.paused),
            state: poolAcc ? poolAcc.state : (a.disabled ? 'disabled' : (a.paused ? 'paused' : 'healthy')),
            healthy: poolAcc ? (poolAcc.state === 'healthy' && Date.now() >= poolAcc.disabledUntil) : true,
            cooldownSec: poolAcc ? Math.max(0, Math.round((poolAcc.disabledUntil - Date.now()) / 1000)) : 0,
            failures: poolAcc ? poolAcc.failures : 0,
            ok: poolAcc ? poolAcc.okCount : 0,
            err: poolAcc ? poolAcc.errCount : 0,
            inflight: poolAcc ? poolAcc.inflight : 0,
            lastError: poolAcc ? poolAcc.lastError : (a.lastLoginError || ''),
            lastLoginAt: a.lastLoginAt || '',
            lastUsedAt: poolAcc ? poolAcc.lastUsedAt : 0,
        };
    });
    res.json({ accounts: list });
});

// 重新载入账号池（面板「重新载入」按钮）
router.post('/api/accounts/reload', (req, res) => {
    const n = accountPool.reload();
    res.json({ ok: true, count: n });
});

// 新增账号
router.post('/api/accounts', (req, res) => {
    const r = accountPool.addAccount(req.body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
});

// 修改账号（token 省略或空字符串则不覆盖磁盘上的真实 Token）
router.patch('/api/accounts/:index', (req, res) => {
    const idx = Number(req.params.index);
    const body = { ...(req.body || {}) };
    if (body.token !== undefined) {
        const t = String(body.token || '').trim();
        const looksMasked = t.includes('…') || t.includes('...');
        if (!t || looksMasked) delete body.token;
    }
    if (body.password !== undefined) {
        const p = String(body.password || '');
        if (p === '******') delete body.password;
    }
    const r = accountPool.updateAccount(idx, body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
});

// 删除账号
router.delete('/api/accounts/:index', (req, res) => {
    const idx = Number(req.params.index);
    const r = accountPool.removeAccount(idx);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
});

// 手动暂停调度
router.post('/api/accounts/:index/pause', (req, res) => {
    const idx = Number(req.params.index);
    const ok = accountPool.pauseAccount(idx);
    res.json({ ok });
});

// 手动恢复调度
router.post('/api/accounts/:index/resume', (req, res) => {
    const idx = Number(req.params.index);
    const ok = accountPool.resumeAccount(idx);
    res.json({ ok });
});

// 一键测试 Token 连通性
router.post('/api/accounts/:index/test', async (req, res) => {
    const idx = Number(req.params.index);
    const acc = accountPool.accounts[idx];
    if (!acc || !acc.token) {
        return res.status(400).json({ ok: false, error: '账号不存在或未配置 Token' });
    }

    try {
        // 创建一次性会话探测 Token
        const sid = await ds.createSession(acc.token);
        // 探测成功后立刻删除探测会话
        await ds.deleteSession(acc.token, sid).catch(() => {});
        accountPool.markOk(acc);
        accountPool.resumeAccount(idx);
        res.json({ ok: true, message: 'Token 验证成功，服务正常！已恢复正常调度。' });
    } catch (e) {
        const bizCode = e.bizCode || (e.message.match(/code=(\d+)/) ? Number(e.message.match(/code=(\d+)/)[1]) : null);
        accountPool.markFail(acc, e, e.statusCode || 500, bizCode);
        res.status(400).json({
            ok: false,
            error: e.message,
            bizCode,
            status: acc.state,
        });
    }
});

// 账号密码换取 Token (自动登录)
router.post('/api/accounts/:index/login', async (req, res) => {
    const idx = Number(req.params.index);
    const acc = accountPool.accounts[idx];
    if (!acc) return res.status(404).json({ error: '账号不存在' });
    if (!acc.password || (!acc.email && !acc.mobile)) {
        return res.status(400).json({ error: '缺少账号或密码，无法自动登录' });
    }

    try {
        const dsLogin = require('../ds-login');
        const loginOpts = { ...acc };
        if (acc.deviceId) loginOpts.deviceId = acc.deviceId;
        const r = await dsLogin.loginAccount(loginOpts);
        if (r.ok && r.token) {
            const patch = {
                token: r.token,
                paused: false,
                lastLoginAt: new Date().toISOString(),
                lastLoginError: '',
            };
            if (r.deviceId) patch.deviceId = r.deviceId;
            accountPool.updateAccount(idx, patch);
            accountPool.resumeAccount(idx);
            res.json({ ok: true, token: r.token, deviceId: r.deviceId || '' });
        } else {
            const err = r.error || '登录失败';
            const patch = { lastLoginError: err };
            if (r.deviceId) patch.deviceId = r.deviceId;
            accountPool.updateAccount(idx, patch);
            res.status(400).json({ ok: false, error: err, deviceId: r.deviceId || '' });
        }
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
