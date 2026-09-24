'use strict';
/**
 * studio/store.js — 本地账号库（accounts.json + 服务端状态镜像）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const MIRROR_FILE = path.join(ROOT, 'data', 'studio-status.json');
const CONFIG_FILE = path.join(ROOT, 'data', 'studio-config.json');

function assertNotC(p) {
    if (/^[cC]:/i.test(path.resolve(p))) throw new Error('禁止写入 C 盘: ' + p);
}

function loadAccounts() {
    try {
        if (!fs.existsSync(ACCOUNTS_FILE)) return [];
        const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function saveAccounts(list) {
    assertNotC(ACCOUNTS_FILE);
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, ACCOUNTS_FILE);
    try {
        const dataPath = path.join(ROOT, 'data', 'accounts.json');
        assertNotC(dataPath);
        fs.mkdirSync(path.dirname(dataPath), { recursive: true });
        fs.writeFileSync(dataPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
    return true;
}

function upsertAccount(patch) {
    const list = loadAccounts();
    const name = String(patch.name || '').trim();
    if (!name) return { ok: false, error: '缺少 name' };
    let item = list.find(a => a.name === name);
    if (!item) {
        item = {
            name,
            token: '',
            email: '',
            mobile: '',
            areaCode: '+86',
            password: '',
            autoLogin: true,
            disabled: false,
            deviceId: '',
            proxy: '',
            lastLoginAt: '',
            lastLoginError: '',
        };
        list.push(item);
    }
    for (const k of ['token', 'email', 'mobile', 'areaCode', 'password', 'deviceId', 'proxy', 'lastLoginAt', 'lastLoginError']) {
        if (patch[k] !== undefined && patch[k] !== null) item[k] = String(patch[k]);
    }
    if (patch.autoLogin !== undefined) item.autoLogin = !!patch.autoLogin;
    saveAccounts(list);
    return { ok: true, account: item };
}

function removeAccount(name) {
    const list = loadAccounts();
    const next = list.filter(a => a.name !== name);
    if (next.length === list.length) return { ok: false, error: '账号不存在' };
    saveAccounts(next);
    return { ok: true };
}

function loadStatusMirror() {
    try {
        if (!fs.existsSync(MIRROR_FILE)) return { at: 0, accounts: [] };
        return JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8'));
    } catch (e) {
        return { at: 0, accounts: [] };
    }
}

function saveStatusMirror(status) {
    try {
        assertNotC(MIRROR_FILE);
        fs.mkdirSync(path.dirname(MIRROR_FILE), { recursive: true });
        fs.writeFileSync(MIRROR_FILE, JSON.stringify(status, null, 2), 'utf8');
    } catch (e) {}
    return true;
}

function loadConfig() {
    const def = {
        remoteBase: process.env.REMOTE_BASE || 'http://166.1.232.147:19728',
        remoteUser: process.env.REMOTE_USER || 'admin',
        remotePass: process.env.REMOTE_PASS || 'admin123',
        autoSyncSec: 10,
        headful: false,
    };
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
            return { ...def, ...JSON.parse(raw) };
        }
    } catch (e) {}
    return def;
}

function saveConfig(patch) {
    const cfg = { ...loadConfig(), ...patch };
    assertNotC(CONFIG_FILE);
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
}

/** 合并本地账号 + 服务端状态镜像 → UI 行 */
function mergedRows() {
    const locals = loadAccounts();
    const mirror = loadStatusMirror();
    const byName = new Map((mirror.accounts || []).map(s => [s.name, s]));
    return locals.map((a, i) => {
        const s = byName.get(a.name) || null;
        return {
            index: i,
            name: a.name,
            email: a.email || '',
            mobile: a.mobile || '',
            hasPassword: !!(a.password && a.password !== '******'),
            hasLocalToken: !!(a.token && a.token.length > 20 && !a.token.startsWith('{')),
            localTokenPreview: a.token ? (a.token.slice(0, 8) + '…' + a.token.slice(-4)) : '',
            deviceId: a.deviceId || '',
            proxy: a.proxy || '',
            lastLoginAt: a.lastLoginAt || '',
            lastLoginError: a.lastLoginError || '',
            remote: s ? {
                index: s.index,
                disabled: !!s.disabled,
                paused: !!s.paused,
                state: s.state,
                healthy: !!s.healthy,
                hasToken: !!s.hasToken,
                failures: s.failures || 0,
                ok: s.ok || 0,
                err: s.err || 0,
                lastError: s.lastError || '',
                lastUsedAt: s.lastUsedAt || 0,
            } : null,
        };
    });
}

module.exports = {
    ACCOUNTS_FILE,
    loadAccounts,
    saveAccounts,
    upsertAccount,
    removeAccount,
    loadStatusMirror,
    saveStatusMirror,
    loadConfig,
    saveConfig,
    mergedRows,
};
