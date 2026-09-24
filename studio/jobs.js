'use strict';
/**
 * studio/jobs.js — 批量换 Token 任务（无头默认，可开有头）
 * 完成后可选自动 syncUp 到反代服务端。
 */
const path = require('path');
const store = require('./store');
const remote = require('./remote');

const ROOT = path.join(__dirname, '..');
let job = null;

function jobSnapshot() {
    if (!job) return { running: false };
    return {
        running: job.running,
        kind: job.kind,
        startedAt: job.startedAt,
        total: job.total,
        done: job.done,
        ok: job.ok,
        fail: job.fail,
        current: job.current,
        log: job.log.slice(-80),
        result: job.result,
    };
}

async function runTokenJob(opts) {
    if (job && job.running) throw new Error('已有任务在运行');
    const o = opts || {};
    const accounts = store.loadAccounts();
    const targets = o.names && o.names.length
        ? accounts.filter(a => o.names.includes(a.name))
        : accounts;

    if (!targets.length) throw new Error('没有可处理的账号');

    process.env.DS_LOGIN_HTTP = '0';
    process.env.DS_LOGIN_HEADFUL = o.headful ? '1' : '0';

    // 延迟加载，避免未跑任务也拉起 ds-login
    const dsLogin = require(path.join(ROOT, 'src', 'ds-login'));

    job = {
        running: true,
        kind: 'token',
        startedAt: Date.now(),
        total: targets.length,
        done: 0,
        ok: 0,
        fail: 0,
        current: '',
        log: ['任务开始: ' + targets.length + ' 个账号'],
        result: null,
    };

    const push = (line) => {
        job.log.push(line);
        if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    };

    (async () => {
        const items = [];
        for (const acc of targets) {
            job.current = acc.name;
            if (!acc.password || (!acc.email && !acc.mobile)) {
                job.fail++;
                job.done++;
                push('跳过 ' + acc.name + ': 缺账密');
                items.push({ name: acc.name, ok: false, error: '缺账密' });
                continue;
            }
            push('登录 ' + acc.name + ' ...');
            try {
                const r = await dsLogin.loginAccount({
                    email: acc.email || '',
                    mobile: acc.mobile || '',
                    areaCode: acc.areaCode || '+86',
                    password: acc.password || '',
                    deviceId: acc.deviceId || '',
                    name: acc.name,
                    profileTag: acc.name,
                    proxy: acc.proxy || '',
                    timeoutMs: 45000,
                    wafTimeoutMs: Number(process.env.DS_WAF_TIMEOUT_MS || 90000),
                    loginRetries: 8,
                });
                if (r.ok && r.token) {
                    const at = new Date().toISOString();
                    store.upsertAccount({
                        name: acc.name,
                        token: r.token,
                        deviceId: r.deviceId || acc.deviceId || '',
                        proxy: acc.proxy || '',
                        lastLoginAt: at,
                        lastLoginError: '',
                    });
                    job.ok++;
                    push('OK ' + acc.name + ' token=' + r.token.slice(0, 12) + '…');
                    items.push({ name: acc.name, token: r.token, deviceId: r.deviceId || '', lastLoginAt: at, ok: true });
                } else {
                    job.fail++;
                    const err = r.error || '登录失败';
                    store.upsertAccount({ name: acc.name, lastLoginError: err, deviceId: r.deviceId || '', proxy: acc.proxy || '' });
                    push('FAIL ' + acc.name + ': ' + err);
                    items.push({ name: acc.name, ok: false, error: err });
                }
                try { await dsLogin.closeSharedBrowser(); } catch (e) {}
            } catch (e) {
                job.fail++;
                push('ERR ' + acc.name + ': ' + e.message);
                items.push({ name: acc.name, ok: false, error: e.message });
            }
            job.done++;
            await new Promise(r => setTimeout(r, 600));
        }

        job.current = '';
        job.result = { at: new Date().toISOString(), items };

        if (o.pushAfter) {
            try {
                push('推送到服务端 ...');
                const cfg = store.loadConfig();
                const cookie = await remote.login(cfg.remoteBase, cfg.remoteUser, cfg.remotePass);
                const payload = store.loadAccounts().map(a => ({
                    name: a.name,
                    email: a.email,
                    mobile: a.mobile,
                    areaCode: a.areaCode,
                    password: a.password,
                    token: a.token,
                    deviceId: a.deviceId,
                    proxy: a.proxy || '',
                    lastLoginAt: a.lastLoginAt,
                    autoLogin: a.autoLogin !== false,
                }));
                const sr = await remote.syncUp(cfg.remoteBase, cookie, payload);
                store.saveStatusMirror({ at: Date.now(), accounts: sr.status || [] });
                push('推送完成 created=' + sr.created + ' updated=' + sr.updated);
            } catch (e) {
                push('推送失败: ' + e.message);
            }
        }

        try { await dsLogin.closeSharedBrowser(); } catch (e) {}
        job.running = false;
        job.current = '';
        push('任务结束 ok=' + job.ok + ' fail=' + job.fail);
    })().catch((e) => {
        job.running = false;
        push('任务异常: ' + e.message);
    });

    return jobSnapshot();
}

async function runPushOnly() {
    if (job && job.running) throw new Error('已有任务在运行');
    const cfg = store.loadConfig();
    job = {
        running: true,
        kind: 'push',
        startedAt: Date.now(),
        total: store.loadAccounts().length,
        done: 0,
        ok: 0,
        fail: 0,
        current: '',
        log: ['仅推送模式'],
        result: null,
    };
    try {
        const cookie = await remote.login(cfg.remoteBase, cfg.remoteUser, cfg.remotePass);
        const payload = store.loadAccounts().map(a => ({
            name: a.name,
            email: a.email,
            mobile: a.mobile,
            areaCode: a.areaCode,
            password: a.password,
            token: a.token,
            deviceId: a.deviceId,
            proxy: a.proxy || '',
            lastLoginAt: a.lastLoginAt,
            autoLogin: a.autoLogin !== false,
        }));
        const sr = await remote.syncUp(cfg.remoteBase, cookie, payload);
        store.saveStatusMirror({ at: Date.now(), accounts: sr.status || [] });
        job.ok = payload.length;
        job.log.push('推送完成 created=' + sr.created + ' updated=' + sr.updated);
        job.result = sr;
    } catch (e) {
        job.fail = 1;
        job.log.push('失败: ' + e.message);
        job.result = { error: e.message };
    }
    job.running = false;
    return jobSnapshot();
}

async function pullStatus() {
    const cfg = store.loadConfig();
    const cookie = await remote.login(cfg.remoteBase, cfg.remoteUser, cfg.remotePass);
    const st = await remote.getStatus(cfg.remoteBase, cookie);
    store.saveStatusMirror({ at: Date.now(), accounts: st.accounts || [] });
    return { ok: true, at: st.at, count: (st.accounts || []).length, cookieHint: true };
}

module.exports = { runTokenJob, runPushOnly, pullStatus, jobSnapshot };
