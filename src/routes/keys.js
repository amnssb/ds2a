'use strict';
/**
 * src/routes/keys.js — 后台认证与 API Key 管理路由
 */
const express = require('express');
const auth = require('../auth');

const router = express.Router();

function requireAdmin(req, res, next) {
    const s = auth.checkSession(req.cookies.ds_admin);
    if (!s) return res.status(401).json({ error: '未登录' });
    req.admin = s;
    next();
}

// 简易登录限速：同来源 10 次 / 分钟，防暴力破解
const loginHits = new Map();
function loginRateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let arr = loginHits.get(ip) || [];
    arr = arr.filter(t => now - t < 60000);
    if (arr.length >= 10) {
        return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
    }
    arr.push(now);
    loginHits.set(ip, arr);
    if (loginHits.size > 1000) {
        for (const [k, v] of loginHits) {
            if (!v.length || now - v[v.length - 1] > 60000) loginHits.delete(k);
        }
    }
    next();
}

router.post('/api/login', loginRateLimit, (req, res) => {
    const { username, password } = req.body || {};
    const r = auth.login(String(username || ''), String(password || ''));
    if (!r.ok) return res.status(401).json({ error: r.error });
    res.setHeader('Set-Cookie', 'ds_admin=' + r.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200');
    res.json({ ok: true, mustChangePassword: r.mustChangePassword });
});

router.post('/api/logout', (req, res) => {
    auth.logout(req.cookies.ds_admin);
    res.setHeader('Set-Cookie', 'ds_admin=; Path=/; Max-Age=0');
    res.json({ ok: true });
});

router.get('/api/me', (req, res) => {
    const s = auth.checkSession(req.cookies.ds_admin);
    if (!s) return res.status(401).json({ error: '未登录' });
    res.json({ ok: true, username: s.username, mustChangePassword: !!auth.db().mustChangePassword });
});

router.post('/api/change-password', requireAdmin, (req, res) => {
    const body = req.body || {};
    const r = auth.changePassword(
        String(body.oldPassword || ''),
        String(body.newPassword || ''),
        req.cookies.ds_admin
    );
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
});

router.get('/api/keys', requireAdmin, (req, res) => {
    res.json({ keys: auth.listKeys() });
});

router.post('/api/keys', requireAdmin, (req, res) => {
    const k = auth.createKey((req.body || {}).name, (req.body || {}).note);
    if (!k || k.ok === false) {
        return res.status(500).json({ error: (k && k.error) || '创建失败' });
    }
    res.json({ ok: true, key: k });
});

router.patch('/api/keys/:id', requireAdmin, (req, res) => {
    const r = auth.updateKey(req.params.id, req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
});

router.delete('/api/keys/:id', requireAdmin, (req, res) => {
    const r = auth.deleteKey(req.params.id);
    res.status(r.ok ? 200 : 400).json(r);
});

router.get('/api/usage', requireAdmin, (req, res) => {
    res.json(auth.getStats());
});

router.post('/api/usage/reset', requireAdmin, (req, res) => {
    const r = auth.resetUsage();
    res.status(r.ok ? 200 : 400).json(r);
});

// 兼容面板历史 GET 误用
router.get('/api/usage/reset', requireAdmin, (req, res) => {
    const r = auth.resetUsage();
    res.status(r.ok ? 200 : 400).json(r);
});

module.exports = {
    router,
    requireAdmin,
};
