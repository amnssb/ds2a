'use strict';
/**
 * studio/remote.js — 反代服务端 API 客户端（登录 / 批量同步 / 状态 / SSE）
 */

async function login(base, user, pass) {
    const r = await fetch(base.replace(/\/$/, '') + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
    });
    const setCookie = r.headers.get('set-cookie') || '';
    const m = setCookie.match(/ds_admin=([^;]+)/);
    if (!r.ok || !m) {
        const t = await r.text().catch(() => '');
        throw new Error('远程登录失败: ' + r.status + ' ' + t);
    }
    return m[1];
}

function cookieHeader(cookie) {
    return { cookie: 'ds_admin=' + cookie };
}

async function getStatus(base, cookie) {
    const r = await fetch(base.replace(/\/$/, '') + '/api/accounts/status', {
        headers: cookieHeader(cookie),
    });
    if (!r.ok) throw new Error('获取状态失败: ' + r.status + ' ' + await r.text());
    return r.json();
}

async function syncUp(base, cookie, accounts) {
    const r = await fetch(base.replace(/\/$/, '') + '/api/accounts/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(cookie) },
        body: JSON.stringify({ accounts }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('同步失败: ' + r.status + ' ' + text);
    return JSON.parse(text);
}

async function setDisabled(base, cookie, index, disabled) {
    const url = base.replace(/\/$/, '') + '/api/accounts/' + index + (disabled ? '/disable' : '/enable');
    const r = await fetch(url, { method: 'POST', headers: cookieHeader(cookie) });
    const text = await r.text();
    if (!r.ok) throw new Error('禁用操作失败: ' + r.status + ' ' + text);
    return JSON.parse(text);
}

/**
 * 打开 SSE；onStatus(payload) 收到 status 事件。
 * 返回 close()。
 */
function openEvents(base, cookie, onStatus, onError) {
    const Abort = globalThis.AbortController;
    const ctrl = new Abort();
    const url = base.replace(/\/$/, '') + '/api/accounts/events';

    (async () => {
        try {
            const r = await fetch(url, {
                headers: cookieHeader(cookie),
                signal: ctrl.signal,
            });
            if (!r.ok || !r.body) {
                if (onError) onError(new Error('SSE HTTP ' + r.status));
                return;
            }
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const chunk = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const lines = chunk.split('\n');
                    let event = 'message';
                    let data = '';
                    for (const line of lines) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) data += line.slice(5).trim();
                    }
                    if (event === 'status' && data) {
                        try { onStatus && onStatus(JSON.parse(data)); } catch (e) {}
                    }
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError' && onError) onError(e);
        }
    })();

    return () => { try { ctrl.abort(); } catch (e) {} };
}

module.exports = { login, getStatus, syncUp, setDisabled, openEvents };
