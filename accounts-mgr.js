'use strict';
/*
 * accounts-mgr.js — 后台账号管理（增删改 + 热加载 + 登录状态探测）
 *
 * accounts.json 结构：
 *   [{ name, email, password, cdpPort, tabs, profile, disabled }]
 *
 *  - 增删改会原子写盘（先写 .tmp 再 rename）
 *  - 热加载：改完由 server 通知 autoscaler / 或重启对应浏览器
 *  - 密码在面板里默认打码显示
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'accounts.json');
const EXAMPLE = path.join(__dirname, 'accounts.example.json');

function readRaw() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) {
        // 没有就初始化空数组（不复制示例里的假账号）
        try { fs.writeFileSync(FILE, '[]', 'utf8'); } catch (e2) {}
        return [];
    }
}

function writeRaw(list) {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
}

function maskPassword(p) {
    if (!p) return '';
    const s = String(p);
    if (s.length <= 2) return '*'.repeat(s.length);
    return s.slice(0, 1) + '*'.repeat(Math.max(3, s.length - 2)) + s.slice(-1);
}

/** 列表（默认打码，reveal=true 时给出明文供编辑） */
function list(reveal) {
    return readRaw().map((a, i) => ({
        index: i,
        name: a.name || ('acc' + (i + 1)),
        email: a.email || '',
        mobile: a.mobile || '',
        areaCode: a.areaCode || '+86',
        token: reveal ? (a.token || '') : (a.token ? (a.token.slice(0,6) + '…' + a.token.slice(-4)) : ''),
        hasToken: !!a.token,
        password: reveal ? (a.password || '') : maskPassword(a.password),
        hasPassword: !!a.password,
        // ---- 自动登录（账号密码 → userToken）----
        autoLogin: a.autoLogin !== false,
        hasAutoLogin: !!(a.password && (a.email || a.mobile)),
        deviceId: a.deviceId || '',
        lastLoginAt: a.lastLoginAt || '',
        lastLoginError: a.lastLoginError || '',
        cdpPort: a.cdpPort || (9331 + i),
        tabs: a.tabs || 1,
        profile: a.profile || '',
        disabled: !!a.disabled,
        status: a.disabled ? 'disabled' : 'enabled',
    }));
}

/** 新增账号：自动分配 cdpPort */
function add(acc) {
    const list = readRaw();
    if (!acc || !acc.name) return { ok: false, error: '缺少 name' };
    const name = String(acc.name).trim();
    if (list.some(a => (a.name || '') === name)) return { ok: false, error: '账号名已存在: ' + name };

    // 端口自动分配（避免冲突）
    const used = new Set(list.map((a, i) => Number(a.cdpPort || (9331 + i))));
    let port = 9331;
    while (used.has(port)) port++;

    const item = {
        name,
        token: String(acc.token || '').trim(),
        email: String(acc.email || '').trim(),
        mobile: String(acc.mobile || '').trim(),
        areaCode: String(acc.areaCode || '+86'),
        password: String(acc.password || ''),
        // 自动登录开关：有密码 + (邮箱|手机号) 时默认开启
        autoLogin: acc.autoLogin !== false,
        deviceId: String(acc.deviceId || ''),
        lastLoginAt: String(acc.lastLoginAt || ''),
        lastLoginError: String(acc.lastLoginError || ''),
        cdpPort: Number(acc.cdpPort || port),
        tabs: Math.max(1, Math.min(16, Number(acc.tabs || 1))),
        profile: String(acc.profile || ''),
        disabled: !!acc.disabled,
    };
    if (used.has(item.cdpPort) && acc.cdpPort) return { ok: false, error: 'cdpPort 冲突: ' + item.cdpPort };
    list.push(item);
    writeRaw(list);
    return { ok: true, account: item, index: list.length - 1 };
}

function update(index, patch) {
    const list = readRaw();
    if (index < 0 || index >= list.length) return { ok: false, error: '索引越界' };
    const a = list[index];
    if (patch.name !== undefined) {
        const nm = String(patch.name).trim();
        if (!nm) return { ok: false, error: 'name 不能为空' };
        if (list.some((x, i) => i !== index && (x.name || '') === nm)) return { ok: false, error: '账号名已存在' };
        a.name = nm;
    }
    if (patch.token !== undefined) a.token = String(patch.token).trim();
    if (patch.email !== undefined) a.email = String(patch.email).trim();
    if (patch.mobile !== undefined) a.mobile = String(patch.mobile).trim();
    if (patch.areaCode !== undefined) a.areaCode = String(patch.areaCode || '+86');
    if (patch.password !== undefined && patch.password !== '') a.password = String(patch.password);
    // 自动登录相关字段（server.js 自动登录成功后写回）
    if (patch.autoLogin !== undefined) a.autoLogin = !!patch.autoLogin;
    if (patch.deviceId !== undefined) a.deviceId = String(patch.deviceId || '');
    if (patch.lastLoginAt !== undefined) a.lastLoginAt = String(patch.lastLoginAt || '');
    if (patch.lastLoginError !== undefined) a.lastLoginError = String(patch.lastLoginError || '');
    if (patch.cdpPort !== undefined) {
        const p = Number(patch.cdpPort);
        if (list.some((x, i) => i !== index && Number(x.cdpPort) === p)) return { ok: false, error: 'cdpPort 冲突' };
        a.cdpPort = p;
    }
    if (patch.tabs !== undefined) a.tabs = Math.max(1, Math.min(16, Number(patch.tabs)));
    if (patch.profile !== undefined) a.profile = String(patch.profile);
    if (patch.disabled !== undefined) a.disabled = !!patch.disabled;
    list[index] = a;
    writeRaw(list);
    return { ok: true, account: a };
}

function remove(index) {
    const list = readRaw();
    if (index < 0 || index >= list.length) return { ok: false, error: '索引越界' };
    const [gone] = list.splice(index, 1);
    writeRaw(list);
    return { ok: true, removed: gone };
}

/** 供 start-pool.js / autoscaler.js 使用（跳过 disabled） */
function forWorkers() {
    return readRaw().filter(a => !a.disabled);
}

module.exports = { list, add, update, remove, readRaw, writeRaw, forWorkers, FILE, EXAMPLE };