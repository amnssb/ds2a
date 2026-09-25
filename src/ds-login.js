'use strict';
/**
 * src/ds-login.js — 「账号 + 密码」浏览器自动登录 chat.deepseek.com，换回 userToken
 * - 登录全程直连，不走任何代理（账号代理仅用于服务端 API 对话/PoW）
 * - 默认无头；DS_LOGIN_HEADFUL=1 走有头窗口（不静默回退无头）
 * - 有头模式下出现验证码/挑战会持续等待人工处理（默认最长 30 分钟，DS_LOGIN_HEADFUL_WAIT_S 可调），绝不自动关闭窗口
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const config = require('./config');
const dspow = require('./pow-engine');

let WS = null;
try {
    WS = require('ws');
} catch (e) {
    try {
        WS = createRequire(path.join(config.ROOT_DIR, 'package.json'))('ws');
    } catch (err) {
        WS = null;
    }
}

const BASE = 'https://chat.deepseek.com';
const LOGIN_PATH = '/api/v0/users/login';
const POW_PATH = '/api/v0/chat/create_pow_challenge';
const PROBE_PATH = '/api/v0/users/current';

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

// 账号级代理：HTTP 登录出口 IP 与 completion 保持一致，降低风控
const dsClient = require('./ds-client');
function loginFetchOpts(proxy, opts) {
    return dsClient.withProxy(proxy, opts);
}

const CHROME_CANDIDATES = [
    process.env.DS_CHROME,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
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

function normalizeToken(raw) {
    if (raw == null) return '';
    let t = String(raw).trim();
    if (!t) return '';
    if (t.startsWith('{')) {
        try {
            const o = JSON.parse(t);
            const v = o && (o.value ?? o.token ?? o.user_token);
            if (v && String(v).trim() && String(v) !== 'null') return String(v).trim();
            return '';
        } catch (e) { return ''; }
    }
    if (t === 'null' || t === 'undefined') return '';
    return t;
}

function pickToken(bd) {
    if (!bd) return '';
    if (bd.user && bd.user.token) return normalizeToken(bd.user.token);
    if (bd.token) return normalizeToken(bd.token);
    if (bd.user_token) return normalizeToken(bd.user_token);
    return '';
}

function friendly(bizCode, msg) {
    const m = String(msg || '');
    if (/RISK_DEVICE_DETECTED/i.test(m)) {
        return '设备风控拦截（RISK_DEVICE_DETECTED）：当前登录环境被 DeepSeek 判定为风险设备';
    }
    if (/password|密码/i.test(m)) return '账号或密码错误（' + m + '）';
    if (bizCode === 40002 || bizCode === 40003) return '账号或密码错误';
    if (bizCode === 40001) return '请求参数被服务端拒绝：' + (m || 'bad request');
    return m || ('登录失败 biz_code=' + bizCode);
}

function isRiskish(out) {
    if (!out || out.ok) return false;
    const s = String((out.error || '') + ' ' + (out.raw || ''));
    return /RISK_DEVICE|RISK_|device_risk|设备风控|40007|40008|40009/i.test(s);
}

function interpret(status, ctype, text, did) {
    const ct = String(ctype || '');
    const body = String(text == null ? '' : text);

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
        return { ok: true, token, user: bd.user || bd, deviceId: did };
    }

    const msg = d.biz_msg || j.msg || j.error_msg || ('code=' + j.code + ' biz_code=' + bizCode);
    const needCode = /code|验证码|verif/i.test(String(msg)) || bizCode === 40005 || bizCode === 40006;
    return { ok: false, needCode, deviceId: did, error: friendly(bizCode, msg), raw: JSON.stringify(j).slice(0, 400) };
}

async function fetchPowHeaderHttp(targetPath, timeoutMs) {
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs || 20000);
        const r = await fetch(BASE + POW_PATH, loginFetchOpts('', {
            method: 'POST',
            headers: Object.assign({}, CLIENT_HEADERS, { 'user-agent': UA }),
            body: JSON.stringify({ target_path: targetPath }),
            signal: ac.signal,
        }));
        clearTimeout(t);
        const j = await r.json();
        const bd = (j && j.data && j.data.biz_data) || {};
        const ch = bd.challenge || bd;
        if (!ch || !ch.challenge) return null;
        const answer = await dspow.solve(ch);
        if (answer < 0) return null;
        return dspow.buildHeader(ch, answer, targetPath);
    } catch (e) {
        return null;
    }
}

async function httpLogin(o) {
    const did = String(o.deviceId || deviceIdFor(seedOf(o)));
    const body = buildBody(o, did);
    const headers = Object.assign({}, CLIENT_HEADERS, {
        'user-agent': UA,
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    });
    const pow = await fetchPowHeaderHttp(LOGIN_PATH, 20000);
    if (pow) headers['x-ds-pow-response'] = pow;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(o.timeoutMs || 25000));
    try {
        const r = await fetch(BASE + LOGIN_PATH, loginFetchOpts('', {
            method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
        }));
        const text = await r.text();
        return interpret(r.status, r.headers.get('content-type'), text, did);
    } catch (e) {
        return { ok: false, waf: true, deviceId: did, error: '登录请求失败: ' + e.message };
    } finally { clearTimeout(timer); }
}

class BrowserSession {
    constructor(opts) {
        const o = opts || {};
        this.headless = o.headless !== false;
        // 登录流程全程直连，不走任何代理（账号代理仅用于 API 对话/PoW 请求）
        this.proxy = '';
        this.proxyArg = null;
        this.proxyUser = '';
        this.proxyPass = '';
        // 每个 profile 用独立调试端口，避免多账号互踢
        let port = Number(o.port || process.env.DS_LOGIN_PORT || 9701);
        if (!o.port && !process.env.DS_LOGIN_PORT && o.tag) {
            let h = 0;
            const s = String(o.tag);
            for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
            port = 9701 + (h % 200);
        }
        this.port = port;
        // 有头专用 profile：避免多账号串会话拿到上一个 userToken
        this.tag = String(o.tag || (this.headless
            ? 'login'
            : ('login-headful-' + (o.profileTag || 'default'))));
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
        if (!exe) throw new Error('找不到 Chrome/Edge 浏览器，无头登录需安装浏览器或配置 DS_CHROME 路径');
        const profileDir = path.join(config.ROOT_DIR, '.chrome-profiles', this.tag);
        fs.mkdirSync(profileDir, { recursive: true });
        const args = [
            this.headless ? '--headless=new' : null,
            this.proxyArg ? ('--proxy-server=' + this.proxyArg) : null,
            '--remote-debugging-port=' + this.port,
            '--user-data-dir=' + profileDir,
            '--disk-cache-dir=' + path.join(profileDir, 'cache'),
            '--crash-dumps-dir=' + path.join(profileDir, 'crash'),
            '--remote-allow-origins=*',
            '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-setuid-sandbox',
            this.headless ? '--disable-gpu' : null,
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            !this.headless ? '--window-size=1280,900' : null,
            !this.headless ? '--start-maximized' : null,
            '--user-agent=' + UA,
            'about:blank',
        ].filter(Boolean);
        this.child = spawn(exe, args, {
            stdio: 'ignore',
            windowsHide: !!this.headless,
            detached: !this.headless,
        });
        this.child.on('error', () => {});

        const ver = await this.waitDevtools();
        await this.connect(ver.webSocketDebuggerUrl);

        const ct = await this.send('Target.createTarget', { url: 'about:blank' });
        const targetId = ct.result.targetId;
        const att = await this.send('Target.attachToTarget', { targetId, flatten: true });
        this.sid = att.result.sessionId;
        if (!this.headless) {
            await this.send('Target.activateTarget', { targetId }).catch(() => {});
        }
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
        await sleep(this.headless === false ? 4000 : 2000);
    }

    async probe() {
        const expr = "(async()=>{try{const r=await fetch(" + JSON.stringify(PROBE_PATH) +
            ",{headers:{'accept':'*/*'}});const ct=r.headers.get('content-type')||'';const t=await r.text();" +
            "return r.status+'|'+ct+'|'+t.slice(0,60);}catch(e){return 'ERR|'+String((e&&e.message)||e)}})()";
        try { return await this.ev(expr); } catch (e) { return 'ERR|' + e.message; }
    }

    async readUserToken() {
        try {
            return normalizeToken(await this.ev(`(function(){try{var r=localStorage.getItem("userToken");if(!r)return"";var o=JSON.parse(r);return (o&&o.value)?String(o.value):"";}catch(e){return""}})()`));
        } catch (e) { return ''; }
    }

    async waitWaf(timeoutMs) {
        const t0 = Date.now();
        const headful = this.headless === false;
        const limit = timeoutMs || (headful ? 180000 : 45000);
        while (Date.now() - t0 < limit) {
            // 有头：人工已登录则直接算过
            if (headful) {
                const tok = await this.readUserToken();
                if (tok && tok.length > 20) return true;
            }
            const p = await this.probe();
            if (typeof p === 'string' && /^\d+\|application\/json/i.test(p)) return true;
            if (typeof p === 'string') {
                const status = parseInt(p, 10);
                const ct = (p.split('|')[1] || '').toLowerCase();
                if (status >= 200 && status < 500 && ct.includes('json')) return true;
            }
            await sleep(1500);
        }
        return false;
    }

    async pagePost(urlPath, body, extraHeaders, opts) {
        const payload = JSON.stringify(body || {});
        const o = opts || {};
        const base = o.clientHeaders === false
            ? "{'content-type':'application/json','accept':'*/*'}"
            : "{'content-type':'application/json','accept':'*/*','x-client-platform':'web','x-client-version':'2.5.0','x-client-locale':'en_US','x-client-bundle-id':'com.deepseek.chat','origin':'https://chat.deepseek.com','referer':'https://chat.deepseek.com/sign_in'}";
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

    /** 页面级统一自适应切换表单模式（CN 验证码登录 -> 密码登录 -> 邮箱/手机登录） */
    async switchFormMode(isEmail) {
        const expr = `(function(){
          try {
            function isVisible(el) {
              if (!el) return false;
              return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            }

            let switchedPwd = false;
            let switchedEmail = false;

            // 1. 若当前页面无密码输入框，说明是国内默认的「验证码登录」模式，自动寻找并点击「密码登录」
            let pwd = document.querySelector('input[type="password"]');
            if (!pwd) {
              const elements = [...document.querySelectorAll('button, a, div[role="button"], span, div, li, [role="tab"], .ds-button__content')];
              const pwdBtn = elements.find(el => {
                const t = (el.textContent || '').replace(/\\s+/g, '');
                return (t.includes('密码登录') || t.includes('账号密码登录') || t.includes('使用密码登录') || t === '密码') && isVisible(el);
              });
              if (pwdBtn) {
                const target = pwdBtn.closest('button, div[role="button"], a') || pwdBtn;
                target.click();
                switchedPwd = true;
              }
              pwd = document.querySelector('input[type="password"]');
            }

            // 2. 在密码登录模式下，针对邮箱账号（国内版通常默认展示手机号+密码），自动切换为「邮箱登录」
            const isTargetEmail = ${JSON.stringify(!!isEmail)};
            if (isTargetEmail) {
              const phoneInput = document.querySelector('input[type="tel"], input[placeholder*="手机"], input[placeholder*="11位"]');
              const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[placeholder*="邮箱" i], input[placeholder*="mail" i]');
              
              if (phoneInput || !hasEmailInput) {
                const elements = [...document.querySelectorAll('button, a, div[role="button"], span, div, li, [role="tab"], .ds-button__content')];
                const emailBtn = elements.find(el => {
                  const t = (el.textContent || '').replace(/\\s+/g, '');
                  const isMatch = (t.includes('邮箱登录') || t.includes('使用邮箱登录') || t.includes('邮箱账号登录') || t === '邮箱') && isVisible(el);
                  if (!isMatch) return false;
                  // 排除当前已经是 active/selected 状态的元素
                  if (el.getAttribute('aria-selected') === 'true' || el.classList.contains('is-active') || el.classList.contains('active')) {
                    return false;
                  }
                  return true;
                });
                if (emailBtn) {
                  const target = emailBtn.closest('button, div[role="button"], a') || emailBtn;
                  target.click();
                  switchedEmail = true;
                }
              }
            } else {
              // 目标为手机号账号：若当前处于邮箱模式，切换回手机登录
              const emailInput = document.querySelector('input[type="email"], input[placeholder*="邮箱" i]');
              if (emailInput) {
                const elements = [...document.querySelectorAll('button, a, div[role="button"], span, div, li, [role="tab"]')];
                const phoneBtn = elements.find(el => {
                  const t = (el.textContent || '').replace(/\\s+/g, '');
                  return (t.includes('手机号登录') || t.includes('手机登录') || t.includes('使用手机登录') || t === '手机') && isVisible(el);
                });
                if (phoneBtn) {
                  const target = phoneBtn.closest('button, div[role="button"], a') || phoneBtn;
                  target.click();
                }
              }
            }

            return JSON.stringify({ pwd: !!pwd, switchedPwd, switchedEmail });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()`;
        try {
            const raw = await this.ev(expr);
            const r = JSON.parse(raw || '{}');
            if (r.switchedPwd) console.log('[ds-login] 自动从验证码登录切换至「密码登录」模式');
            if (r.switchedEmail) console.log('[ds-login] 自动从手机号模式切换至「邮箱登录」模式');
            return r;
        } catch (e) {
            return {};
        }
    }

    async waitSignInForm(timeoutMs, isEmail = true) {
        const t0 = Date.now();
        const limit = timeoutMs || 60000;
        while (Date.now() - t0 < limit) {
            await this.switchFormMode(isEmail);
            const expr = `(function(){
              try {
                let pwd = document.querySelector('input[type="password"]');
                if (!pwd) return 'none';
                const form = pwd.form || pwd.closest('form');
                let inputEl = ${JSON.stringify(isEmail)}
                  ? document.querySelector('input[type="email"],input[name="email"],input[placeholder*="mail" i],input[placeholder*="邮箱" i],input[autocomplete="username"]')
                  : document.querySelector('input[name="mobile"],input[type="tel"],input[placeholder*="手机" i],input[autocomplete="username"]');
                if (!inputEl && form) inputEl = form.querySelector('input:not([type="password"])');
                return 'ok|' + (inputEl ? '1' : '0');
              } catch(e) { return 'err|' + e.message; }
            })()`;
            try {
                const s = await this.ev(expr);
                if (typeof s === 'string' && s.startsWith('ok|')) return true;
            } catch (e) {}
            await sleep(800);
        }
        return false;
    }

    /** 单次检查登录表单是否可见（不等待） */
    async signInFormVisible(isEmail = true) {
        try {
            await this.switchFormMode(isEmail);
            const s = await this.ev(`(function(){
              try {
                const pwd = document.querySelector('input[type="password"]');
                return pwd ? '1' : '';
              } catch(e) { return ''; }
            })()`);
            return s === '1';
        } catch (e) { return false; }
    }

    /** 检测验证码 / WAF 挑战元素（有头模式下据此提示人工处理并暂停自动提交） */
    async detectVerification() {
        try {
            const s = await this.ev(`(function(){
              try {
                if (document.querySelector('iframe[src*="captcha"],iframe[src*="challenge"],iframe[title*="captcha" i],.cf-turnstile,.g-recaptcha,#challenge-stage,#challenge-form,[class*="captcha" i]')) return '1';
                const t = String(document.title || '');
                if (/attention required|just a moment|verify|challenge/i.test(t)) return '1';
                return '';
              } catch(e) { return ''; }
            })()`);
            return s === '1';
        } catch (e) { return false; }
    }

    async fillAndSubmitLogin(o) {
        const email = String(o.email || '').trim();
        const mobile = String(o.mobile || '').trim();
        const password = String(o.password || '');
        const account = email || mobile;
        const isEmail = !!email;
        if (!account || !password) return false;

        // 提交前先确保已切换到对应模式
        await this.switchFormMode(isEmail);
        await sleep(300);

        const expr = `(function(){
          try {
            function isVisible(el) {
              if (!el) return false;
              return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            }

            let pwd = document.querySelector('input[type="password"]');
            if (!pwd) return 'no-pwd';
            const form = pwd.form || pwd.closest('form');

            // 查找账号输入框（邮箱或手机）
            let accountEl = null;
            const isTargetEmail = ${JSON.stringify(isEmail)};
            if (isTargetEmail) {
              accountEl = document.querySelector('input[type="email"],input[name="email"],input[placeholder*="mail" i],input[placeholder*="邮箱" i],input[autocomplete="username"]');
            } else {
              accountEl = document.querySelector('input[name="mobile"],input[type="tel"],input[placeholder*="手机" i],input[placeholder*="11位"]');
            }
            if (!accountEl && form) {
              const inputs = [...(form.querySelectorAll('input')||[])].filter(i => i !== pwd && i.type !== 'hidden' && i.type !== 'submit');
              accountEl = inputs[0] || null;
            }
            if (!accountEl) {
              const allInputs = [...document.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="submit"])')];
              accountEl = allInputs.find(i => isVisible(i)) || allInputs[0] || null;
            }
            if (!accountEl) return 'no-account-input';

            const acc = ${JSON.stringify(account)};
            const pass = ${JSON.stringify(password)};

            function setVal(el, val) {
              const proto = Object.getPrototypeOf(el);
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc && desc.set) {
                desc.set.call(el, val);
              } else {
                el.value = val;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }

            setVal(accountEl, acc);
            setVal(pwd, pass);

            // 查找登录提交按钮
            let btn = (form && (form.querySelector('button[type="submit"],button'))) ||
                      document.querySelector('button[type="submit"]');
            if (!btn) {
              btn = [...document.querySelectorAll('button,div[role="button"],span,.ds-button')].find(function(el){
                const t = (el.textContent||'').replace(/\\s+/g, '');
                return (t === '登录' || t === '立即登录' || t === 'Sign In' || t === 'Log In' || /登录|sign in/i.test(t)) && isVisible(el);
              });
            }
            if (!btn) return 'no-btn';
            btn.click();
            return 'clicked';
          } catch(e) { return 'err|' + e.message; }
        })()`;
        try {
            const r = await this.ev(expr);
            console.log('[ds-login] 表单登录:', r);
            return r === 'clicked';
        } catch (e) {
            console.log('[ds-login] 表单登录异常:', e.message);
            return false;
        }
    }

    async login(o) {
        let did = String(o.deviceId || deviceIdFor(seedOf(o)));
        const body = buildBody(o, did);

        await this.openSignIn();
        const headful = this.headless === false;
        // 有头模式：默认等待 DS_LOGIN_HEADFUL_WAIT_S（30 分钟）供人工处理验证码；
        // 上层未显式传 wafTimeoutMs 时不会用短超时把浏览器提前关掉
        const wafTimeout = o.wafTimeoutMs || Number(process.env.DS_WAF_TIMEOUT_S || (headful ? HEADFUL_WAIT_S : 45)) * 1000;

        if (headful) {
            const t0 = Date.now();
            let lastLog = 0;
            let submitted = false;
            let submitAt = 0;
            let verifyHinted = false;
            console.log('[ds-login] 有头：窗口已打开，等待登录/人工操作，最长 ' + Math.round(wafTimeout / 60000) + ' 分钟（如出现验证码请在窗口手动完成，脚本不会自动关闭窗口）');
            while (Date.now() - t0 < wafTimeout) {
                const tok = await this.readUserToken();
                if (tok && tok.length > 20) {
                    return { ok: true, token: tok, deviceId: did, from: 'manual-headful' };
                }

                // 验证元素检测：提示人工处理，绝不自动退出、绝不打断
                const verify = await this.detectVerification();
                if (verify && !verifyHinted) {
                    verifyHinted = true;
                    console.log('[ds-login] 检测到验证/挑战元素，请在浏览器窗口手动完成，脚本持续等待 token…');
                } else if (!verify) {
                    verifyHinted = false;
                }

                if (!submitted) {
                    const formOk = await this.waitSignInForm(4000, !!o.email);
                    if (formOk) {
                        const clicked = await this.fillAndSubmitLogin(o);
                        if (clicked) {
                            submitted = true;
                            submitAt = Date.now();
                            console.log('[ds-login] 已提交表单，等待出 token / 验证码…');
                        }
                    }
                } else if (Date.now() - submitAt > 8000) {
                    // 提交后 8s 仍无 token：仅当登录表单重新可见（说明提交被退回）才补交，
                    // 验证期间绝不重复提交打扰人工操作
                    const tok2 = await this.readUserToken();
                    if (tok2 && tok2.length > 20) {
                        return { ok: true, token: tok2, deviceId: did, from: 'form-headful' };
                    }
                    if (!verify && await this.signInFormVisible(!!o.email)) {
                        await this.fillAndSubmitLogin(o);
                        submitAt = Date.now();
                    }
                }

                const elapsed = Date.now() - t0;
                if (elapsed - lastLog >= 30000) {
                    lastLog = elapsed;
                    console.log('[ds-login] 有头登录中… ' + Math.round(elapsed / 1000) + 's / ' + Math.round(wafTimeout / 1000) + 's' + (submitted ? ' (已提交表单)' : ' (等表单)') + (verify ? ' (等待人工验证)' : ''));
                }
                await sleep(1000);
            }
            const tokEnd = await this.readUserToken();
            if (tokEnd && tokEnd.length > 20) {
                return { ok: true, token: tokEnd, deviceId: did, from: 'manual-headful' };
            }
            // 有头超时：仍带上下文返回，便于上层提示人工登录
            return { ok: false, waf: true, deviceId: did, error: '有头登录等待超时：未拿到 userToken（可在窗口完成验证码/手动登录后重试）' };
        }

        const wafOk = await this.waitWaf(wafTimeout);
        if (!wafOk) {
            return { ok: false, waf: true, deviceId: did, error: 'AWS WAF 挑战未通过（IP 可能被风控拦截）' };
        }

        try {
            const pageDid = await this.ev(`(function(){
              try {
                const ls = window.localStorage || {};
                const keys = ['device_id','deviceId','ds_device_id','__ds_device_id','deviceid'];
                for (const k of keys) {
                  const v = ls.getItem && ls.getItem(k);
                  if (v && String(v).length >= 8) return String(v);
                }
                const m = document.cookie.match(/(?:^|;\\s*)(device_id|deviceId|ds_device_id)=([^;]+)/i);
                if (m && m[2]) return decodeURIComponent(m[2]);
              } catch(e) {}
              return '';
            })()`);
            if (pageDid && String(pageDid).trim()) did = String(pageDid).trim();
        } catch (e) {}
        body.device_id = did;

        let pow = null;
        try {
            const chRes = await this.pagePost(POW_PATH, { target_path: LOGIN_PATH });
            if (chRes.status === 200 && chRes.text && chRes.text.charAt(0) === '{') {
                const j = JSON.parse(chRes.text);
                const bd = (j && j.data && j.data.biz_data) || {};
                const c = bd.challenge || bd;
                if (c && c.challenge) {
                    const answer = await dspow.solve(c);
                    if (answer >= 0) pow = dspow.buildHeader(c, answer, LOGIN_PATH);
                }
            }
        } catch (e) {}

        const tries = Math.max(1, Number(o.loginRetries || process.env.DS_LOGIN_RETRIES || 6));
        let lr = null;
        let out = null;
        for (let i = 0; i < tries; i++) {
            lr = await this.pagePost(LOGIN_PATH, body, pow ? { 'x-ds-pow-response': pow } : {});
            if (lr.status === 0) return { ok: false, deviceId: did, error: '页面内请求失败: ' + lr.error };
            out = interpret(lr.status, lr.ctype, lr.text, did);
            if (!out.waf) {
                if (out.ok && out.token) {
                    const nt = normalizeToken(out.token);
                    if (nt && nt.length > 20) out.token = nt;
                    try {
                        const lsTok = await this.readUserToken();
                        if (lsTok && lsTok.length > 20) out.token = lsTok;
                    } catch (e) {}
                    if (!normalizeToken(out.token)) {
                        for (let k = 0; k < 10; k++) {
                            await sleep(800);
                            const lsTok = await this.readUserToken();
                            if (lsTok && lsTok.length > 20) {
                                out.token = lsTok;
                                break;
                            }
                        }
                    }
                    const finalTok = normalizeToken(out.token);
                    if (finalTok) {
                        out.token = finalTok;
                        return out;
                    }
                    out.ok = false;
                    out.error = '登录响应未拿到有效 userToken（可能是壳数据）';
                }
                if (!out.ok) {
                    const manual = await this.readUserToken();
                    if (manual && manual.length > 20) {
                        return { ok: true, token: manual, deviceId: did, from: 'manual-after-login' };
                    }
                }
                return out;
            }
            pow = null;
            await sleep(2000 + i * 800);
            try { await this.probe(); } catch (e) {}
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

const SESSIONS = new Map();
const STARTING = new Map();
let IDLE_TIMER = null;
const IDLE_MS = Number(process.env.DS_LOGIN_IDLE_S || 120) * 1000;

// 有头模式等待人工处理验证码/手动登录的最长时间（默认 30 分钟，可配）
const HEADFUL_WAIT_S = Number(process.env.DS_LOGIN_HEADFUL_WAIT_S || 1800);

async function sharedSession(headless, profileTag) {
    const key = (headless ? 'h' : 'f') + ':' + (profileTag || 'default');
    const cur = SESSIONS.get(key);
    if (cur && cur.alive) return cur;
    if (STARTING.has(key)) return STARTING.get(key);
    const p = (async () => {
        const s = new BrowserSession({ headless, tag: headless ? 'login' : ('login-headful-' + (profileTag || 'default')) });
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

async function dropShared(headless, profileTag) {
    const key = (headless ? 'h' : 'f') + ':' + (profileTag || 'default');
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

function httpAllowed() {
    const v = String(process.env.DS_LOGIN_HTTP || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

async function loginViaBrowsers(o) {
    if (!WS) {
        return { ok: false, error: '浏览器登录失败：缺少 ws 依赖（npm i ws），且未找到可用浏览器' };
    }

    // 默认纯无头；DS_LOGIN_HEADFUL=1 时走有头（窗口可见，便于人工处理验证），
    // 有头模式绝不静默回退无头，否则窗口一闪而过等于没有有头
    const headful = process.env.DS_LOGIN_HEADFUL === '1' || process.env.DS_LOGIN_HEADFUL === 'true';
    const order = headful ? [false] : [true];
    const profileTag = o.profileTag || o.name || seedOf(o) || 'default';
    let last = null;

    for (const hl of order) {
        let sess;
        try {
            sess = await sharedSession(hl, profileTag);
        } catch (e) {
            last = { ok: false, error: (hl ? '无头' : '有头') + '浏览器启动失败: ' + e.message };
            continue;
        }

        try {
            const r = await sess.login(o);
            touchShared();
            if (r.ok) return r;
            last = r;
            // 有头模式失败（等待人工处理超时等）保留浏览器窗口，由上层决定何时关闭；
            // 仅无头失败路径立即回收浏览器
            if (hl && (r.waf || isRiskish(r))) await dropShared(hl, profileTag);
        } catch (e) {
            last = { ok: false, error: '浏览器登录异常: ' + e.message };
            await dropShared(hl, profileTag).catch(() => {});
        }
    }
    return last || { ok: false, error: '浏览器登录未产生结果' };
}

async function login(opts) {
    const o = opts || {};
    const email = String(o.email || '').trim();
    const mobile = String(o.mobile || '').trim();
    if (!email && !mobile) return { ok: false, error: '缺少邮箱或手机号' };
    if (!o.password && !o.code) return { ok: false, error: '缺少密码' };

    // 默认：始终无头浏览器登录（不先打裸 HTTP）
    // 仅当 DS_LOGIN_HTTP=1 时，才先试 HTTP，失败后再无头兜底
    if (httpAllowed()) {
        const fast = await httpLogin(o);
        if (fast.ok) return fast;
        if (!fast.waf && !isRiskish(fast)) return fast;
        const br = await loginViaBrowsers(o);
        if (br && br.ok) return br;
        return br || fast;
    }

    return loginViaBrowsers(o);
}

module.exports = {
    login,
    loginAccount: login,
    deviceIdFor,
    findChrome,
    BrowserSession,
    closeSharedBrowser,
    BASE,
    LOGIN_PATH,
    POW_PATH,
};
