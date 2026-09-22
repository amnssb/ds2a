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

router.post('/api/login', (req, res) => {
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
    const r = auth.changePassword(String((req.body || {}).oldPassword || ''), String((req.body || {}).newPassword || ''));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
});

router.get('/api/keys', requireAdmin, (req, res) => {
    res.json({ keys: auth.listKeys() });
});

router.post('/api/keys', requireAdmin, (req, res) => {
    res.json({ ok: true, key: auth.createKey((req.body || {}).name, (req.body || {}).note) });
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

module.exports = {
    router,
    requireAdmin,
};
