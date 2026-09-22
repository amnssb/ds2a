'use strict';
/*
 * ds-login.js — 「账号 + 密码」自动登录 chat.deepseek.com，换回 userToken
 *
 * 两条路径：
 *   A) 纯 HTTP 快路径（约 1-2 秒）—— 部分网络/IP 下可直接通
 *   B) 无头 Chrome 路径（约 10-30 秒）—— 先过 AWS WAF，再在页面上下文里调登录接口
 *
 * 为什么要 B：chat.deepseek.com 前置了 AWS WAF。纯 HTTP 打 /api/v0/users/login
 * 会一直拿到 202 + text/html 的 WAF JS 挑战页（body 为空），请求根本进不了业务层。
 * 必须由浏览器执行那段 JS 拿到 aws-waf-token，再带 cookie 发请求。
 *
 * 浏览器路径流程：
 *   1) 起 headless Chrome（profile 放本项目 .chrome-profiles/ 下，不占 C 盘）
 *   2) 打开 /sign_in，轮询 /api/v0/users/current 直到返回 JSON（= WAF 已通过）
 *   3) 页面内 fetch 取 PoW 挑战 → Node 侧用 ds-pow.js 求解
 *   4) 页面内 fetch /api/v0/users/login，带 x-ds-pow-response
 *   5) 从 biz_data.user.token 取 userToken
 *
 * 特性：
 *   - 邮箱登录 / 手机号登录（area_code 默认 +86，二选一）
 *   - 稳定 device_id：由账号派生，同一账号每次都是同一台「设备」，避免风控
 *   - PoW 取不到时自动降级为「不带 PoW 头」再试一次
 *   - 需要验证码时返回 needCode=true，调用方可补 code 再调一次
 *   - 无头过不了 WAF 时可设 DS_LOGIN_HEADFUL=1 用有头模式手动过一次
 *   - 登录 POST 会被 WAF 波动性拦截（同请求这次 202、下次放行），内部自动重试 6 次
 *
 * 环境变量：
 *   DS_CHROME          指定 Chrome/Edge 可执行文件路径
 *   DS_LOGIN_PORT      CDP 调试端口（默认 9701）
 *   DS_LOGIN_HEADFUL   1 = 直接用有头浏览器
 *   DS_LOGIN_RETRIES   登录 POST 被 WAF 拦时的重试次数（默认 6）
 *   DS_LOGIN_IDLE_S    共享浏览器闲置多少秒后自动关闭（默认 120）
 *   DS_WAF_TIMEOUT_S   等 WAF 挑战通过的最长秒数（默认 45）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const dspow = require('./ds-pow');

let WS = null;
try { WS = createRequire(path.join(__dirname, 'package.json'))('ws'); } catch (e) { WS = null; }

const BASE = 'https://chat.deepseek.com';
const LOGIN_PATH = '/api/v0/users/login';
const POW_PATH = '/api/v0/chat/create_pow_challenge';
const PROBE_PATH = '/api/v0/users/current';

// 与官方 web 客户端一致的请求头（缺了会被拒）
const CLIENT_HEADERS = {
    'accept': '*/*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    'referer': BASE + '/sign_in',
    'origin': BASE,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_CANDIDATES = [
    process.env.DS_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findChrome() {
    for (const c of CHROME_CANDIDATES) {
        try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
    return '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 稳定 device_id：由账号派生，保证同一账号每次登录都是同一台「设备」 */
function deviceIdFor(seed) {
    const h = crypto.createHash('sha256').update('dsweb2api:' + String(seed || 'anon')).digest('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function seedOf(o) {
    const email = String(o.email || '').trim();
    const mobile = String(o.mobile || '').trim();
    return email || (String(o.areaCode || '+86') + mobile);
}

function buildBody(o, did) {
    const email = String(o.email || '').trim();
    const mobile = String(o.mobile || '').trim();
    const body = { device_id: did, os: 'web' };
    if (mobile) { body.mobile = mobile; body.area_code = String(o.areaCode || '+86'); }
    else { body.email = email; }
    if (o.password) body.password = String(o.password);
    if (o.code) { body.code = String(o.code); body.verification_code = String(o.code); }
    return body;
}

// ---------- 响应解释（HTTP / 浏览器共用） ----------
function pickToken(bd) {
    if (!bd) return '';
    if (bd.user && bd.user.token) return String(bd.user.token);
    if (bd.token) return String(bd.token);
    if (bd.user_token) return String(bd.user_token);
    return '';
}

function friendly(bizCode, msg) {
    const m = String(msg || '');
    if (/password|密码/i.test(m)) return '账号或密码错误（' + m + '）';
    if (bizCode === 40002 || bizCode === 40003) return '账号或密码错误';
    if (bizCode === 40001) return '请求参数被服务端拒绝：' + (m || 'bad request');
    return m || ('登录失败 biz_code=' + bizCode);
}

/**
 * 把一次登录响应翻译成结果对象
 * @returns {{ok:boolean, token?:string, user?:object, deviceId:string,
 *            needCode?:boolean, waf?:boolean, error?:string, raw?:string}}
 */
function interpret(status, ctype, text, did) {
    const ct = String(ctype || '');
    const body = String(text == null ? '' : text);

    // 202 / text-html / 空 body = 被 AWS WAF 拦在业务层之外
    if (status === 202 || /text\/html/i.test(ct) || (!body && status >= 200 && status < 300)) {
        return { ok: false, waf: true, deviceId: did, error: '被 AWS WAF 拦截（需浏览器先过挑战）' };
    }
    if (status >= 400) {
        return { ok: false, deviceId: did, error: 'HTTP ' + status + ': ' + body.slice(0, 200), raw: body.slice(0, 400) };
    }

    let j;
    try { j = JSON.parse(body); }
    catch (e) { return { ok: false, deviceId: did, error: '登录响应非 JSON: ' + body.slice(0, 200) }; }

    const d = j.data || {};
    const bd = d.biz_data || {};
    const bizCode = d.biz_code;
    const token = pickToken(bd);

    if (token && (j.code == null || j.code === 0) && (bizCode == null || bizCode === 0)) {
        console.log('[login] 登录成功，token 长度 ' + token.length);
        return { ok: true, token, user: bd.user || bd, deviceId: did };
    }

    const msg = d.biz_msg || j.msg || j.error_msg || ('code=' + j.code + ' biz_code=' + bizCode);
    const needCode = /code|验证码|verif/i.test(String(msg)) || bizCode === 40005 || bizCode === 40006;
    return { ok: false, needCode, deviceId: did, error: friendly(bizCode, msg), raw: JSON.stringify(j).slice(0, 400) };
}

// ---------- A) 纯 HTTP 快路径 ----------
/** 取登录 PoW 挑战并求解，返回 x-ds-pow-response（失败返回 null） */
async function fetchPowHeaderHttp(targetPath, timeoutMs) {
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs || 20000);
        const r = await fetch(BASE + POW_PATH, {
            method: 'POST',
            headers: Object.assign({}, CLIENT_HEADERS, { 'user-agent': UA }),
            body: JSON.stringify({ target_path: targetPath }),
            signal: ac.signal,
        });
        clearTimeout(t);
        const j = await r.json();
        const bd = (j && j.data && j.data.biz_data) || {};
        const ch = bd.challenge || bd;   // 兼容 {challenge:{...}} 与扁平两种形态
        if (!ch || !ch.challenge) return null;
        const t0 = Date.now();
        const answer = dspow.solvePow(ch.challenge, ch.salt, ch.expire_at, ch.difficulty);
        if (answer < 0) return null;
        console.log('[login-pow] ' + targetPath + ' answer=' + answer + ' 耗时=' + (Date.now() - t0) + 'ms');
        return dspow.buildPowHeader(ch, answer, targetPath);
    } catch (e) {
        return null;
    }
}

async function httpLogin(o) {
    const did = String(o.deviceId || deviceIdFor(seedOf(o)));
    const body = buildBody(o, did);
    // 最小头：带 x-client-* 会触发 AWS WAF（见文件头注释）
    const headers = { 'accept': '*/*', 'content-type': 'application/json', 'user-agent': UA, 'origin': BASE, 'referer': BASE + '/sign_in' };
    const pow = await fetchPowHeaderHttp(LOGIN_PATH);
    if (pow) headers['x-ds-pow-response'] = pow;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(o.timeoutMs || 25000));
    try {
        const r = await fetch(BASE + LOGIN_PATH, {
            method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
        });
        const text = await r.text();
        return interpret(r.status, r.headers.get('content-type'), text, did);
    } catch (e) {
        return { ok: false, waf: true, deviceId: did, error: '登录请求失败: ' + e.message };
    } finally { clearTimeout(timer); }
}

// ---------- B) 无头 Chrome 路径（过 AWS WAF） ----------
class BrowserSession {
    constructor(opts) {
        const o = opts || {};
        this.headless = o.headless !== false;
        this.port = Number(o.port || process.env.DS_LOGIN_PORT || 9701);
        this.tag = String(o.tag || (this.headless ? 'login' : 'login-headful'));
        this.child = null;
        this.ws = null;
        this.sid = null;
        this.seq = 0;
        this.waiters = new Map();
        this.alive = false;
    }

    async start() {
        if (!WS) throw new Error('缺少 ws 依赖（npm i ws）');
        const exe = findChrome();
        if (!exe) throw new Error('找不到 Chrome/Edge，可用环境变量 DS_CHROME 指定路径');
        // profile 放项目目录下（D 盘），不往 C 盘写
        const profileDir = path.join(__dirname, '.chrome-profiles', this.tag);
        fs.mkdirSync(profileDir, { recursive: true });
        const args = [
            this.headless ? '--headless=new' : null,
            '--remote-debugging-port=' + this.port,
            '--user-data-dir=' + profileDir,
            '--disk-cache-dir=' + path.join(profileDir, 'cache'),
            '--crash-dumps-dir=' + path.join(profileDir, 'crash'),
            '--remote-allow-origins=*',
            '--no-first-run', '--no-default-browser-check', '--no-sandbox',
            '--disable-gpu', '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--user-agent=' + UA,
            'about:blank',
        ].filter(Boolean);
        this.child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
        this.child.on('error', () => {});

        const ver = await this.waitDevtools();
        await this.connect(ver.webSocketDebuggerUrl);

        const ct = await this.send('Target.createTarget', { url: 'about:blank' });
        const att = await this.send('Target.attachToTarget', { targetId: ct.result.targetId, flatten: true });
        this.sid = att.result.sessionId;
        await this.send('Page.enable', {}, this.sid);
        await this.send('Runtime.enable', {}, this.sid);
        this.alive = true;
        return this;
    }

    async waitDevtools() {
        for (let i = 0; i < 120; i++) {
            try {
                const r = await fetch('http://127.0.0.1:' + this.port + '/json/version');
                if (r.ok) return await r.json();
            } catch (e) {}
            await sleep(300);
        }
        throw new Error('Chrome 调试端口无响应（' + this.port + '）');
    }

    connect(url) {
        return new Promise((res, rej) => {
            this.ws = new WS(url, { origin: 'http://127.0.0.1:' + this.port });
            this.ws.on('message', raw => {
                let m;
                try { m = JSON.parse(raw.toString()); } catch (e) { return; }
                if (m.id && this.waiters.has(m.id)) { this.waiters.get(m.id)(m); this.waiters.delete(m.id); }
            });
            this.ws.once('open', res);
            this.ws.once('error', rej);
        });
    }

    send(method, params, sid) {
        return new Promise((res, rej) => {
            const id = ++this.seq;
            const t = setTimeout(() => { this.waiters.delete(id); rej(new Error('CDP 超时 ' + method)); }, 60000);
            this.waiters.set(id, m => { clearTimeout(t); res(m); });
            this.ws.send(JSON.stringify(sid ? { id, method, params: params || {}, sessionId: sid } : { id, method, params: params || {} }));
        });
    }

    async ev(expr) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.sid);
        const res = r.result || {};
        if (res.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 200));
        return res.result ? res.result.value : undefined;
    }

    async openSignIn() {
        await this.send('Page.navigate', { url: BASE + '/sign_in' }, this.sid);
        await sleep(1500);
    }

    /** 探测 WAF 是否已放行：返回 '200|application/json|...' 表示已进业务层 */
    async probe() {
        const expr = "(async()=>{try{const r=await fetch(" + JSON.stringify(PROBE_PATH) +
            ",{headers:{'accept':'*/*'}});const ct=r.headers.get('content-type')||'';const t=await r.text();" +
            "return r.status+'|'+ct+'|'+t.slice(0,60);}catch(e){return 'ERR|'+String((e&&e.message)||e)}})()";
        try { return await this.ev(expr); } catch (e) { return 'ERR|' + e.message; }
    }

    /** 等 AWS WAF 挑战自动通过 */
    async waitWaf(timeoutMs) {
        const t0 = Date.now();
        const limit = timeoutMs || 45000;
        while (Date.now() - t0 < limit) {
            const p = await this.probe();
            if (typeof p === 'string' && p.indexOf('200|application/json') === 0) return true;
            await sleep(1200);
        }
        return false;
    }

    /**
     * 在页面上下文里 POST 一个 JSON 接口
     *
     * 关键：登录/未鉴权接口必须用 **最小头**（只有 content-type + accept）。
     * 实测带 x-client-platform / x-client-version / x-client-bundle-id 这几个自定义头
     * 会被 AWS WAF 直接判为异常流量，返回 202 + text/html + 空 body；
     * 用最小头则正常进业务层（返回 JSON）。
     *
     * @param {string} urlPath
     * @param {object} body
     * @param {object} extraHeaders  额外头（如 x-ds-pow-response）
     * @param {object} opts          { clientHeaders: true 时才附带 x-client-* 全套头 }
     */
    async pagePost(urlPath, body, extraHeaders, opts) {
        const payload = JSON.stringify(body || {});
        const o = opts || {};
        const base = o.clientHeaders
            ? "{'content-type':'application/json','accept':'*/*','x-client-platform':'web','x-client-version':'2.5.0','x-client-locale':'en_US','x-client-bundle-id':'com.deepseek.chat'}"
            : "{'content-type':'application/json','accept':'*/*'}";
        const extra = JSON.stringify(extraHeaders || {});
        const expr = "(async()=>{try{const r=await fetch(" + JSON.stringify(urlPath) +
            ",{method:'POST',headers:Object.assign(" + base + "," + extra +
            "),body:" + JSON.stringify(payload) +
            "});const t=await r.text();return JSON.stringify({status:r.status,ctype:r.headers.get('content-type')||'',text:t});" +
            "}catch(e){return JSON.stringify({status:0,error:String((e&&e.message)||e)})}})()";
        const raw = await this.ev(expr);
        try { return JSON.parse(raw); }
        catch (e) { return { status: 0, error: '页面返回无法解析: ' + String(raw).slice(0, 120) }; }
    }

    async login(o) {
        const did = String(o.deviceId || deviceIdFor(seedOf(o)));
        const body = buildBody(o, did);

        await this.openSignIn();
        const wafOk = await this.waitWaf(o.wafTimeoutMs || Number(process.env.DS_WAF_TIMEOUT_S || 45) * 1000);
        if (!wafOk) {
            return { ok: false, waf: true, deviceId: did,
                     error: 'AWS WAF 挑战未通过（可设 DS_LOGIN_HEADFUL=1 用有头模式手动过一次）' };
        }

        // PoW：登录接口本身不强制要 PoW（挑战接口 /create_pow_challenge 反而要 token）。
        // 这里仍然尝试一次：拿到了就用，拿不到（Missing Token 等）就直接裸登。
        let pow = null;
        try {
            const chRes = await this.pagePost(POW_PATH, { target_path: LOGIN_PATH });
            if (chRes.status === 200 && chRes.text && chRes.text.charAt(0) === '{') {
                const j = JSON.parse(chRes.text);
                const bd = (j && j.data && j.data.biz_data) || {};
                const c = bd.challenge || bd;
                if (c && c.challenge) {
                    const t0 = Date.now();
                    const answer = dspow.solvePow(c.challenge, c.salt, c.expire_at, c.difficulty);
                    if (answer >= 0) {
                        pow = dspow.buildPowHeader(c, answer, LOGIN_PATH);
                        console.log('[login-pow] browser answer=' + answer + ' 耗时=' + (Date.now() - t0) + 'ms');
                    }
                }
            }
        } catch (e) {
            console.warn('[login] PoW 跳过（' + e.message + '），直接裸登');
        }

        // 最小头登录（带 x-client-* 会被 WAF 拦成 202）
        //
        // 关键：AWS WAF 的判定是**波动**的 —— 完全相同的请求，这一次返回 202 +
        // 空 body（被拦），下一次就正常进业务层返回 JSON。实测同一分钟内两种结果
        // 都会出现。所以这里对「被 WAF 拦」的响应做多次重试，每次重试前先打一次
        // probe（顺带刷新 aws-waf-token），而不是一次 202 就放弃。
        const tries = Math.max(1, Number(o.loginRetries || process.env.DS_LOGIN_RETRIES || 6));
        let lr = null;
        let out = null;
        for (let i = 0; i < tries; i++) {
            lr = await this.pagePost(LOGIN_PATH, body, pow ? { 'x-ds-pow-response': pow } : {});
            if (lr.status === 0) return { ok: false, deviceId: did, error: '页面内请求失败: ' + lr.error };
            out = interpret(lr.status, lr.ctype, lr.text, did);
            if (!out.waf) return out;                 // 进业务层了（成功或账号密码错），直接返回
            pow = null;                               // 带 PoW 可能反而被拦 → 后续轮去掉
            await sleep(1200 + i * 400);
            try { await this.probe(); } catch (e) {}  // 触发一次 WAF cookie 刷新
        }
        return out;
    }

    async close() {
        this.alive = false;
        try { this.ws && this.ws.close(); } catch (e) {}
        try { this.child && this.child.kill(); } catch (e) {}
        await sleep(300);
    }
}

// ---------- 共享浏览器实例（批量登录时复用，省掉反复起浏览器） ----------
const SESSIONS = new Map();     // key -> BrowserSession
const STARTING = new Map();     // key -> Promise
let IDLE_TIMER = null;
const IDLE_MS = Number(process.env.DS_LOGIN_IDLE_S || 120) * 1000;

async function sharedSession(headless) {
    const key = headless ? 'h' : 'f';
    const cur = SESSIONS.get(key);
    if (cur && cur.alive) return cur;
    if (STARTING.has(key)) return STARTING.get(key);
    const p = (async () => {
        const s = new BrowserSession({ headless });
        await s.start();
        SESSIONS.set(key, s);
        return s;
    })().finally(() => STARTING.delete(key));
    STARTING.set(key, p);
    return p;
}

function touchShared() {
    if (IDLE_TIMER) clearTimeout(IDLE_TIMER);
    IDLE_TIMER = setTimeout(() => { closeSharedBrowser().catch(() => {}); }, IDLE_MS);
    if (IDLE_TIMER.unref) IDLE_TIMER.unref();
}

async function dropShared(headless) {
    const key = headless ? 'h' : 'f';
    const s = SESSIONS.get(key);
    SESSIONS.delete(key);
    if (s) await s.close().catch(() => {});
}

async function closeSharedBrowser() {
    if (IDLE_TIMER) { clearTimeout(IDLE_TIMER); IDLE_TIMER = null; }
    const all = [...SESSIONS.values()];
    SESSIONS.clear();
    for (const s of all) await s.close().catch(() => {});
    return all.length;
}

// ---------- 对外主入口 ----------
/**
 * 登录换 token（先试纯 HTTP，被 WAF 拦了就自动走无头 Chrome）
 * @param {object} opts { email, mobile, areaCode, password, code, deviceId, timeoutMs, wafTimeoutMs }
 * @returns {Promise<{ok:boolean, token?:string, user?:object, deviceId?:string,
 *                    needCode?:boolean, waf?:boolean, error?:string, raw?:string}>}
 */
async function login(opts) {
    const o = opts || {};
    const email = String(o.email || '').trim();
    const mobile = String(o.mobile || '').trim();
    if (!email && !mobile) return { ok: false, error: '缺少邮箱或手机号' };
    if (!o.password && !o.code) return { ok: false, error: '缺少密码' };

    // A) 纯 HTTP（快）
    const fast = await httpLogin(o);
    if (fast.ok || !fast.waf) return fast;

    // B) 浏览器过 WAF
    if (!WS) return Object.assign({}, fast, { error: fast.error + '（且缺少 ws 依赖，无法用浏览器路径）' });

    const headful = process.env.DS_LOGIN_HEADFUL === '1' || process.env.DS_LOGIN_HEADFUL === 'true';
    const order = headful ? [false] : [true, false];   // 无头不行就退有头
    let last = fast;

    for (const hl of order) {
        let sess;
        try { sess = await sharedSession(hl); }
        catch (e) { last = { ok: false, error: '启动浏览器失败: ' + e.message }; continue; }

        try {
            const r = await sess.login(o);
            touchShared();
            if (r.ok || !r.waf) return r;
            last = r;
            await dropShared(hl);      // WAF 没过，这个实例没用了
        } catch (e) {
            last = { ok: false, error: '浏览器登录异常: ' + e.message };
            await dropShared(hl).catch(() => {});
        }
    }
    return last;
}

module.exports = {
    login,
    deviceIdFor,
    findChrome,
    BrowserSession,
    closeSharedBrowser,
    BASE,
    LOGIN_PATH,
    POW_PATH,
};
