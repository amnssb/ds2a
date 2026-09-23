'use strict';
/**
 * studio/server.js — 本机批量账号 Studio
 * 用法: node studio/server.js   (默认 http://127.0.0.1:19729)
 * 职责: 本地批量管理 → 换 Token → 上行 sync → 下行 status/SSE 同步显示
 */
const express = require('express');
const path = require('path');
const store = require('./store');
const remote = require('./remote');
const jobs = require('./jobs');

const PORT = Number(process.env.STUDIO_PORT || 19729);
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS（便于直接开文件调试）
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.get('/api/rows', (req, res) => {
    const mirror = store.loadStatusMirror();
    res.json({
        at: mirror.at || 0,
        rows: store.mergedRows(),
        total: store.loadAccounts().length,
    });
});

app.get('/api/accounts', (req, res) => {
    res.json({ accounts: store.loadAccounts().map(a => ({ ...a, password: a.password ? '******' : '' })) });
});

app.post('/api/accounts', (req, res) => {
    const body = req.body || {};
    if (Array.isArray(body.accounts)) {
        let n = 0;
        for (const a of body.accounts) {
            if (store.upsertAccount(a).ok) n++;
        }
        return res.json({ ok: true, upserted: n });
    }
    const r = store.upsertAccount(body);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
});

app.delete('/api/accounts/:name', (req, res) => {
    const r = store.removeAccount(req.params.name);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
});

// 批量导入: 每行 name,email,password 或 JSON 数组
app.post('/api/accounts/import', (req, res) => {
    const text = String((req.body && req.body.text) || '');
    let added = 0;
    const errors = [];
    if (text.trim().startsWith('[')) {
        try {
            const arr = JSON.parse(text);
            for (const a of arr) {
                if (store.upsertAccount(a).ok) added++;
                else errors.push(String(a && a.name || '?'));
            }
        } catch (e) {
            return res.status(400).json({ ok: false, error: 'JSON 解析失败: ' + e.message });
        }
    } else {
        for (const line of text.split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s.startsWith('#')) continue;
            const parts = s.split(/[,\t]/).map(x => x.trim());
            if (!parts[0]) continue;
            const r = store.upsertAccount({
                name: parts[0],
                email: parts[1] || '',
                password: parts[2] || '',
            });
            if (r.ok) added++;
            else errors.push(parts[0]);
        }
    }
    res.json({ ok: true, added, errors });
});

app.get('/api/config', (req, res) => {
    const c = store.loadConfig();
    res.json({ ...c, remotePass: c.remotePass ? '******' : '' });
});

app.post('/api/config', (req, res) => {
    const body = { ...(req.body || {}) };
    if (body.remotePass === '******' || body.remotePass === '') delete body.remotePass;
    const c = store.saveConfig(body);
    res.json({ ...c, remotePass: c.remotePass ? '******' : '' });
});

app.post('/api/job/token', async (req, res) => {
    try {
        const r = await jobs.runTokenJob({
            names: req.body && req.body.names,
            headful: !!(req.body && req.body.headful),
            pushAfter: !!(req.body && req.body.pushAfter),
        });
        res.json(r);
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post('/api/job/push', async (req, res) => {
    try {
        res.json(await jobs.runPushOnly());
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post('/api/job/pull', async (req, res) => {
    try {
        res.json(await jobs.pullStatus());
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.get('/api/job', (req, res) => {
    res.json(jobs.jobSnapshot());
});

// 本机状态镜像
app.get('/api/status-mirror', (req, res) => {
    res.json(store.loadStatusMirror());
});

// 手动对服务端禁用/启用（随后 pull 或 SSE 会刷新显示）
app.post('/api/remote-disable', async (req, res) => {
    try {
        const cfg = store.loadConfig();
        const cookie = await remote.login(cfg.remoteBase, cfg.remoteUser, cfg.remotePass);
        const st = await remote.getStatus(cfg.remoteBase, cookie);
        const row = (st.accounts || []).find(a => a.name === req.body.name);
        if (!row) return res.status(404).json({ ok: false, error: '服务端无此账号' });
        await remote.setDisabled(cfg.remoteBase, cookie, row.index, !!req.body.disabled);
        const st2 = await remote.getStatus(cfg.remoteBase, cookie);
        store.saveStatusMirror({ at: Date.now(), accounts: st2.accounts || [] });
        res.json({ ok: true, name: req.body.name, disabled: !!req.body.disabled });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// SSE 下发给本机页面（Studio 自己聚合服务端状态）
let lastMirrorPush = null;
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    const send = (event, data) => {
        try {
            res.write('event: ' + event + '\n');
            res.write('data: ' + JSON.stringify(data) + '\n\n');
        } catch (e) {}
    };

    send('hello', { at: Date.now(), rows: store.mergedRows(), job: jobs.jobSnapshot() });

    const timer = setInterval(() => {
        const j = jobs.jobSnapshot();
        send('job', j);
        const m = store.loadStatusMirror();
        if (m.at !== lastMirrorPush) {
            lastMirrorPush = m.at;
            send('status', m);
            send('rows', { rows: store.mergedRows(), at: m.at });
        }
        try { res.write(': ping\n\n'); } catch (e) {}
    }, 1500);

    req.on('close', () => clearInterval(timer));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log('[studio] 本机账号 Studio: http://127.0.0.1:' + PORT + '/');
    console.log('[studio] 数据文件: ' + store.ACCOUNTS_FILE);
});
