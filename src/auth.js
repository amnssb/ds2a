'use strict';
/**
 * src/auth.js — 后台登录认证与 API Key 管理
 * 数据严格落盘于 data/auth-data.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DATA_FILE = config.AUTH_DATA_FILE;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function hashPassword(pw, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const h = crypto.scryptSync(String(pw), s, 64).toString('hex');
    return { salt: s, hash: h };
}
function verifyPassword(pw, salt, hash) {
    try {
        const got = crypto.scryptSync(String(pw), salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(hash, 'hex'));
    } catch (e) { return false; }
}

function load() {
    try {
        config.assertNotCDrive(DATA_FILE);
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { return null; }
}

function save(db) {
    try {
        config.assertNotCDrive(DATA_FILE);
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
        fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
        console.error('[auth] 保存失败:', e.message);
    }
}

function init(envUser, envPass) {
    let db = load();
    if (!db) {
        const u = envUser || config.ADMIN_USER;
        const p = envPass || config.ADMIN_PASS;
        const { salt, hash } = hashPassword(p);
        db = {
            createdAt: nowIso(),
            mustChangePassword: !envPass,
            admin: { username: u, salt, hash, updatedAt: nowIso() },
            apiKeys: [],
            sessions: {},
            stats: {
                total: { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 },
                byKey: {},
                byAccount: {},
                byDay: {},
            },
        };
        save(db);
        console.log('[auth] 已生成初始账号: ' + u + ' / ' + (envPass ? '(来自环境变量)' : p) + '（请尽快在面板修改）');
    }
    return db;
}

let DB = null;
function db() { if (!DB) DB = init(); return DB; }
function persist() { save(DB); }

function login(username, password) {
    const d = db();
    if (!d.admin || d.admin.username !== username) return { ok: false, error: '用户名或密码错误' };
    if (!verifyPassword(password, d.admin.salt, d.admin.hash)) return { ok: false, error: '用户名或密码错误' };
    const token = crypto.randomBytes(32).toString('hex');
    d.sessions[token] = { username, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: nowIso() };
    for (const [t, s] of Object.entries(d.sessions)) if (s.expiresAt < Date.now()) delete d.sessions[t];
    persist();
    return { ok: true, token, mustChangePassword: !!d.mustChangePassword };
}

function checkSession(token) {
    if (!token) return null;
    const d = db();
    const s = d.sessions[token];
    if (!s) return null;
    if (s.expiresAt < Date.now()) { delete d.sessions[token]; persist(); return null; }
    return s;
}

function logout(token) {
    const d = db();
    if (d.sessions[token]) { delete d.sessions[token]; persist(); return true; }
    return false;
}

function changePassword(oldPw, newPw) {
    const d = db();
    if (!verifyPassword(oldPw, d.admin.salt, d.admin.hash)) return { ok: false, error: '旧密码错误' };
    if (!newPw || String(newPw).length < 4) return { ok: false, error: '新密码至少 4 位' };
    const { salt, hash } = hashPassword(newPw);
    d.admin.salt = salt;
    d.admin.hash = hash;
    d.admin.updatedAt = nowIso();
    d.mustChangePassword = false;
    persist();
    return { ok: true };
}

function createKey(name, note) {
    const d = db();
    const id = 'k_' + crypto.randomBytes(6).toString('hex');
    const secret = 'sk-ds-' + crypto.randomBytes(24).toString('hex');
    const item = {
        id,
        name: String(name || ('key-' + id.slice(2, 6))).trim(),
        note: String(note || '').trim(),
        key: secret,
        createdAt: nowIso(),
        lastUsedAt: '',
        enabled: true,
    };
    d.apiKeys.push(item);
    persist();
    _invalidateKeyCache();
    return item;
}

function listKeys() {
    const d = db();
    return d.apiKeys.map(k => ({
        id: k.id,
        name: k.name,
        note: k.note,
        key: k.key,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        enabled: k.enabled,
        stats: d.stats.byKey[k.id] || { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 },
    }));
}

function updateKey(id, patch) {
    const d = db();
    const k = d.apiKeys.find(x => x.id === id);
    if (!k) return { ok: false, error: 'Key 不存在' };
    if (patch.name) k.name = String(patch.name).trim();
    if (patch.note !== undefined) k.note = String(patch.note).trim();
    if (patch.enabled !== undefined) k.enabled = !!patch.enabled;
    persist();
    _invalidateKeyCache();
    return { ok: true, key: k };
}

function deleteKey(id) {
    const d = db();
    const i = d.apiKeys.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, error: 'Key 不存在' };
    d.apiKeys.splice(i, 1);
    delete d.stats.byKey[id];
    persist();
    _invalidateKeyCache();
    return { ok: true };
}

// API Key 查找缓存（O(1)）— 在 Key 集合变更时需调用 _invalidateKeyCache()
let _keyCache = null;
function _invalidateKeyCache() { _keyCache = null; }
function _buildKeyCache(d) {
    _keyCache = new Map();
    for (const k of (d.apiKeys || [])) {
        if (k.enabled) _keyCache.set(k.key, k);
    }
}

function verifyApiKey(raw) {
    if (!raw) return null;
    let key = String(raw).trim();
    if (key.startsWith('Bearer ')) key = key.slice(7).trim();
    const d = db();
    // 懒建缓存
    if (!_keyCache) _buildKeyCache(d);
    const k = _keyCache.get(key);
    if (!k || !k.enabled) return null;
    k.lastUsedAt = nowIso();
    return { keyId: k.id, name: k.name };
}

function dayKey(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function recordUsage(info) {
    const d = db();
    const pk = info.promptTokens || 0, ck = info.completionTokens || 0, tk = info.thinkingTokens || 0;
    const bump = (o) => {
        o.requests = (o.requests || 0) + 1;
        o.promptTokens = (o.promptTokens || 0) + pk;
        o.completionTokens = (o.completionTokens || 0) + ck;
        o.thinkingTokens = (o.thinkingTokens || 0) + tk;
        o.totalTokens = (o.totalTokens || 0) + pk + ck + tk;
        if (info.ok) o.ok = (o.ok || 0) + 1; else o.err = (o.err || 0) + 1;
    };
    bump(d.stats.total);
    if (info.keyId) {
        if (!d.stats.byKey[info.keyId]) d.stats.byKey[info.keyId] = { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 };
        bump(d.stats.byKey[info.keyId]);
    }
    if (info.account) {
        if (!d.stats.byAccount[info.account]) d.stats.byAccount[info.account] = { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 };
        bump(d.stats.byAccount[info.account]);
    }
    const dk = dayKey();
    if (!d.stats.byDay[dk]) d.stats.byDay[dk] = { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 };
    bump(d.stats.byDay[dk]);

    if (Date.now() - (recordUsage._last || 0) > 3000) {
        recordUsage._last = Date.now();
        persist();
    }
}

function getStats() {
    const d = db();
    const keys = listKeys();
    return {
        total: d.stats.total,
        byKey: keys.map(k => ({ id: k.id, name: k.name, enabled: k.enabled, lastUsedAt: k.lastUsedAt, key: k.key.slice(0, 12) + '…', ...k.stats })),
        byAccount: Object.entries(d.stats.byAccount).map(([name, s]) => ({ name, ...s })),
        byDay: Object.entries(d.stats.byDay).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 30).map(([date, s]) => ({ date, ...s })),
    };
}

module.exports = {
    init, db, persist, flush: persist,
    login, logout, checkSession, changePassword,
    createKey, listKeys, updateKey, deleteKey, verifyApiKey,
    recordUsage, getStats,
};
