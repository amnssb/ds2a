#!/usr/bin/env node
'use strict';
/**
 * 本机有头浏览器登录 DeepSeek 换 Token，再 API 推到服务器
 * 用法: DS_LOGIN_HEADFUL=1 node push-tokens-headful.js
 */
process.env.DS_LOGIN_HEADFUL = '1';
process.env.DS_LOGIN_HTTP = '0';

const fs = require('fs');
const path = require('path');
const dsLogin = require('./src/ds-login');

const REMOTE = process.env.REMOTE_BASE || 'http://166.1.232.147:19728';
const REMOTE_USER = process.env.REMOTE_USER || 'admin';
const REMOTE_PASS = process.env.REMOTE_PASS || 'admin123';
const LOCAL_ACCOUNTS = path.join(__dirname, 'accounts.json');
const OUT_FILE = path.join(__dirname, 'data', 'token-push-result.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadAccounts() {
    const list = JSON.parse(fs.readFileSync(LOCAL_ACCOUNTS, 'utf8'));
    if (!Array.isArray(list)) throw new Error('accounts.json 不是数组');
    return list;
}

async function remoteLogin() {
    const r = await fetch(REMOTE + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: REMOTE_USER, password: REMOTE_PASS }),
    });
    const setCookie = r.headers.get('set-cookie') || '';
    const m = setCookie.match(/ds_admin=([^;]+)/);
    if (!r.ok || !m) {
        const t = await r.text();
        throw new Error('远程登录失败: ' + r.status + ' ' + t);
    }
    return m[1];
}

async function remoteAccounts(cookie) {
    const r = await fetch(REMOTE + '/api/accounts?reveal=1', {
        headers: { cookie: 'ds_admin=' + cookie },
    });
    if (!r.ok) throw new Error('读取远程账号失败: ' + r.status + ' ' + await r.text());
    return (await r.json()).accounts || [];
}

async function remoteCreate(cookie, acc, token) {
    const body = {
        name: acc.name,
        email: acc.email || '',
        mobile: acc.mobile || '',
        areaCode: acc.areaCode || '+86',
        password: acc.password || '',
        token: token || '',
        deviceId: acc.deviceId || '',
        proxy: acc.proxy || '',
        autoLogin: true,
        disabled: false,
        paused: false,
    };
    const r = await fetch(REMOTE + '/api/accounts', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            cookie: 'ds_admin=' + cookie,
        },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('远程创建 ' + acc.name + ' 失败: ' + r.status + ' ' + text);
    try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function remotePatch(cookie, index, patch) {
    const r = await fetch(REMOTE + '/api/accounts/' + index, {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            cookie: 'ds_admin=' + cookie,
        },
        body: JSON.stringify(patch),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('远程更新 acc#' + index + ' 失败: ' + r.status + ' ' + text);
    try { return JSON.parse(text); } catch { return { raw: text }; }
}

function saveLocalToken(name, token, deviceId, lastLoginAt, extra = {}) {
    const list = loadAccounts();
    const item = list.find(a => a.name === name);
    if (!item) return false;
    item.token = token;
    if (extra.banned) {
        item.paused = true;
        item.lastLoginError = extra.statusMsg || '账号已被官方永久封禁';
        item.disabledUntil = 0;
        item.frozenUntil = '';
    } else if (extra.frozen) {
        item.paused = false;
        item.disabledUntil = extra.muteUntil || 0;
        item.frozenUntil = extra.frozenUntil || '';
        item.lastLoginError = extra.statusMsg || `账号被官方暂时冻结至 ${extra.frozenUntil}`;
    } else {
        item.paused = false;
        item.disabledUntil = 0;
        item.frozenUntil = '';
        item.lastLoginError = '';
    }
    if (lastLoginAt) item.lastLoginAt = lastLoginAt;
    if (deviceId) item.deviceId = deviceId;
    fs.writeFileSync(LOCAL_ACCOUNTS, JSON.stringify(list, null, 2), 'utf8');
    try {
        const dataPath = path.join(__dirname, 'data', 'accounts.json');
        fs.writeFileSync(dataPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
    return true;
}

async function headfulLogin(acc) {
    console.log('\n========== 有头登录 ' + acc.name + ' (' + (acc.email || acc.mobile) + ') ==========');
    console.log('将打开 Chrome；有验证码请在窗口点完，或直接手动登录，脚本会自动抓 token 与风控状态喵');
    const loginOpts = {
        email: acc.email || '',
        mobile: acc.mobile || '',
        areaCode: acc.areaCode || '+86',
        password: acc.password || '',
        deviceId: acc.deviceId || '',
        name: acc.name,
        profileTag: acc.name,
        proxy: acc.proxy || '',
        timeoutMs: 45000,
        loginRetries: 8,
    };
    const t0 = Date.now();
    const timer = setInterval(() => {
        console.log('  ...已等待 ' + Math.round((Date.now() - t0) / 1000) + 's');
    }, 10000);
    try {
        const r = await dsLogin.loginAccount(loginOpts);
        if (r.ok && r.token) {
            if (r.frozen) {
                console.log('⚠️ ' + acc.name + ' 登录成功，但账号处于【暂时冻结】状态至 ' + r.frozenUntil + '！已自动设置冻结时间喵');
            } else if (r.banned) {
                console.log('🚨 ' + acc.name + ' 登录成功，但账号已被官方【永久封禁】: ' + r.statusMsg + '！已标记暂停调度喵');
            } else {
                console.log('✅ ' + acc.name + ' 登录成功 via=' + (r.from || 'api') + ' token=' + String(r.token).slice(0, 16) + '…');
            }
            // 账号间强制关窗，避免会话串号
            try { await dsLogin.closeSharedBrowser(); } catch (e) {}
            return r;
        }
        try { await dsLogin.closeSharedBrowser(); } catch (e) {}
        console.log('❌ ' + acc.name + ' 登录失败: ' + (r.error || 'unknown'));
        return r;
    } finally {
        clearInterval(timer);
    }
}

(async () => {
    const accounts = loadAccounts();
    const results = { at: new Date().toISOString(), remote: REMOTE, items: [] };

    // 1) 本机有头浏览器逐个换 Token
    for (const acc of accounts) {
        if (!acc.password || (!acc.email && !acc.mobile)) {
            console.log('跳过 ' + acc.name + '：缺账密');
            results.items.push({ name: acc.name, ok: false, error: '缺少账密' });
            continue;
        }
        const r = await headfulLogin(acc);
        if (r.ok && r.token) {
            const at = new Date().toISOString();
            saveLocalToken(acc.name, r.token, r.deviceId || acc.deviceId || '', at, r);
            results.items.push({
                name: acc.name,
                ok: true,
                token: r.token,
                deviceId: r.deviceId || '',
                lastLoginAt: at,
                frozen: r.frozen,
                banned: r.banned,
                muteUntil: r.muteUntil,
                frozenUntil: r.frozenUntil,
                statusMsg: r.statusMsg,
            });
        } else {
            results.items.push({
                name: acc.name,
                ok: false,
                error: r.error || '登录失败',
                deviceId: r.deviceId || '',
            });
        }
        await sleep(800);
    }

    // 2) API 推到服务器
    try {
        const cookie = await remoteLogin();
        console.log('\n远程登录成功:', REMOTE);
        let remote = await remoteAccounts(cookie);
        results.remoteAccounts = remote.map(a => ({ index: a.index, name: a.name, hasToken: a.hasToken }));
        results.pushed = [];

        // 本地账号若远程不存在，先创建（带账密；Token 有则一并带上）
        for (const localAcc of accounts) {
            if (remote.some(a => a.name === localAcc.name)) continue;
            const localItem = results.items.find(x => x.name === localAcc.name);
            try {
                await remoteCreate(cookie, localAcc, localItem && localItem.token ? localItem.token : '');
                console.log('➕ 远程已创建', localAcc.name);
            } catch (e) {
                console.log('⚠ 创建远程账号失败', localAcc.name, e.message);
                results.pushed.push({ name: localAcc.name, ok: false, error: e.message });
            }
        }
        remote = await remoteAccounts(cookie);

        for (const item of results.items) {
            if (!item.ok || !item.token) continue;
            let target = remote.find(a => a.name === item.name);
            if (!target) {
                const la = accounts.find(x => x.name === item.name);
                target = remote.find(a => la && a.email && la.email && a.email === la.email);
            }
            if (!target) {
                results.pushed.push({ name: item.name, ok: false, error: '远程无同名账号' });
                console.log('⚠ 远程没有账号 ' + item.name);
                continue;
            }
            try {
                const patchData = {
                    token: item.token,
                    lastLoginError: item.statusMsg || '',
                };
                if (item.banned) {
                    patchData.paused = true;
                } else if (item.frozen) {
                    patchData.paused = false;
                    patchData.disabledUntil = item.muteUntil;
                    patchData.frozenUntil = item.frozenUntil;
                } else {
                    patchData.paused = false;
                    patchData.disabledUntil = 0;
                    patchData.frozenUntil = '';
                }
                if (la && la.proxy !== undefined) patchData.proxy = la.proxy || '';
                if (item.deviceId || (la && la.deviceId)) patchData.deviceId = item.deviceId || la.deviceId;
                const pr = await remotePatch(cookie, target.index, patchData);
                results.pushed.push({ name: item.name, index: target.index, ok: true, remote: pr });
                console.log('⬆ 已推送 ' + item.name + ' -> remote#' + target.index + (patchData.proxy ? (' proxy=' + patchData.proxy) : ''));
            } catch (e) {
                results.pushed.push({ name: item.name, index: target.index, ok: false, error: e.message });
                console.log('❌ 推送失败', item.name, e.message);
            }
        }
        results.remoteLoginOk = true;
    } catch (e) {
        results.remoteLoginOk = false;
        results.remoteError = e.message;
        console.log('❌ 远程推送失败:', e.message);
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
    console.log('\n结果已写入', OUT_FILE);

    const okCount = results.items.filter(x => x.ok).length;
    const pushOk = (results.pushed || []).filter(x => x.ok).length;
    console.log('本地登录成功', okCount + '/' + results.items.length, '，远程推送成功', pushOk);
    try { await dsLogin.closeSharedBrowser(); } catch (e) {}
    process.exit(okCount > 0 ? 0 : 1);
})().catch(async (e) => {
    console.error('FATAL', e);
    try { await dsLogin.closeSharedBrowser(); } catch (_) {}
    process.exit(1);
});
