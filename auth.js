'use strict';
/*
 * auth.js — 后台登录 + API Key 管理 + 按 Key / 按账号统计
 *
 * 设计要点：
 *  - 后台管理员：用户名 + 密码（scrypt 加盐哈希），登录后发 session cookie
 *  - API Key：独立于 DeepSeek 账号，不绑定（一个 key 可用全部账号池）
 *  - 统计维度：按 key 计 token/请求，按 DeepSeek 账号计 token/请求
 *  - 落盘：auth-data.json（不进 git，面板里可改密码）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'auth-data.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 小时

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
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { return null; }
}
function save(db) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); }
    catch (e) { console.error('[auth] 保存失败:', e.message); }
}

/** 初始化：首次运行时创建默认管理员 admin / admin（面板里要求改密） */
function init(envUser, envPass) {
    let db = load();
    if (!db) {
        const u = envUser || 'admin';
        const p = envPass || 'admin';
        const { salt, hash } = hashPassword(p);
        db = {
            createdAt: nowIso(),
            mustChangePassword: !envPass,
            admin: { username: u, salt, hash, updatedAt: nowIso() },
            apiKeys: [],       // { id, name, key, createdAt, lastUsedAt, enabled, note }
            sessions: {},      // token -> { username, expiresAt }
            stats: {
                total: { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 },
                byKey: {},      // keyId -> {...}
                byAccount: {},  // accountName -> {...}
                byDay: {},      // YYYY-MM-DD -> {...}
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

// ---------- 管理员登录 ----------
function login(username, password) {
    const d = db();
    if (!d.admin || d.admin.username !== username) return { ok: false, error: '用户名或密码错误' };
    if (!verifyPassword(password, d.admin.salt, d.admin.hash)) return { ok: false, error: '用户名或密码错误' };
    const token = crypto.randomBytes(32).toString('hex');
    d.sessions[token] = { username, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: nowIso() };
    // 清理过期 session
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
    if (!verifyPassword(oldPw, d.admin.salt, d.admin.hash)) return { ok: false, error: '原密码错误' };
    if (!newPw || String(newPw).length < 4) return { ok: false, error: '新密码至少 4 位' };
    const { salt, hash } = hashPassword(newPw);
    d.admin.salt = salt; d.admin.hash = hash; d.admin.updatedAt = nowIso();
    d.mustChangePassword = false;
    persist();
    return { ok: true };
}

// ---------- API Key ----------
function genKey() {
    return 'sk-ds-' + crypto.randomBytes(24).toString('hex');
}

function createKey(name, note) {
    const d = db();
    const k = {
        id: 'k_' + crypto.randomBytes(6).toString('hex'),
        name: String(name || '未命名').slice(0, 60),
        note: String(note || '').slice(0, 200),
        key: genKey(),
        createdAt: nowIso(),
        lastUsedAt: null,
        enabled: true,
    };
    d.apiKeys.push(k);
    d.stats.byKey[k.id] = { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 };
    persist();
    return k;
}

function listKeys() {
    const d = db();
    return d.apiKeys.map(k => ({
        id: k.id, name: k.name, note: k.note, key: k.key,
        createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, enabled: k.enabled,
        stats: d.stats.byKey[k.id] || { requests: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0, ok: 0, err: 0 },
    }));
}

function updateKey(id, patch) {
    const d = db();
    const k = d.apiKeys.find(x => x.id === id);
    if (!k) return { ok: false, error: 'key 不存在' };
    if (typeof patch.name === 'string') k.name = patch.name.slice(0, 60);
    if (typeof patch.note === 'string') k.note = patch.note.slice(0, 200);
    if (typeof patch.enabled === 'boolean') k.enabled = patch.enabled;
    persist();
    return { ok: true, key: k };
}

function deleteKey(id) {
    const d = db();
    const i = d.apiKeys.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, error: 'key 不存在' };
    d.apiKeys.splice(i, 1);
    persist();
    return { ok: true };
}

/** 校验请求携带的 API key。返回 { keyId, name } 或 null */
function verifyApiKey(raw) {
    if (!raw) return null;
    const token = String(raw).replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const d = db();
    const k = d.apiKeys.find(x => x.key === token);
    if (!k || !k.enabled) return null;
    k.lastUsedAt = nowIso();
    return { keyId: k.id, name: k.name };
}

// ---------- 统计 ----------
function dayKey(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 记录一次调用。promptTokens/completionTokens/thinkingTokens 为估算值 */
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
    // 节流落盘：统计不需要每次都写
    if (Date.now() - (recordUsage._last || 0) > 5000) { recordUsage._last = Date.now(); persist(); }
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

function flush() { persist(); }

module.exports = {
    init, db, persist, flush,
    login, logout, checkSession, changePassword,
    createKey, listKeys, updateKey, deleteKey, verifyApiKey,
    recordUsage, getStats,
};