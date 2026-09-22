'use strict';
/*
 * ds-client.js — DeepSeek 纯 HTTP 客户端（无浏览器）
 *
 * 协议来自 https://github.com/anojndr/chat.deepseek.com-to-openai-api 的实现（实测可用）：
 *   - 会话 token 直接当 Bearer 用（从浏览器 localStorage 的 userToken.value 提取）
 *   - 上传 / 对话都需要 x-ds-pow-response 头（PoW 用官方 wasm 求解）
 *   - 上传后要轮询 /api/v0/file/fetch_files 到 SUCCESS
 *   - 对话走 SSE，p=response/thinking_content 是思考链，p=response/content 是正文
 *   - 多轮用 parent_message_id 续接（只发最新一条用户消息）
 */
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const BASE = 'https://chat.deepseek.com';
const TARGET_COMPLETION = '/api/v0/chat/completion';
const TARGET_UPLOAD = '/api/v0/file/upload_file';

// 与官方 web 客户端一致的请求头（缺了会被拒）
const CLIENT_HEADERS = {
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    'referer': BASE + '/a/chat/',
    'origin': BASE,
};

const OK_CODES = new Set([0, null, undefined]);
const STALL_TIMEOUT_MS = Number(process.env.DS_STALL_TIMEOUT_S || 90) * 1000;
const FILE_POLL_MS = 400;
const FILE_WAIT_MS = Number(process.env.DS_FILE_WAIT_S || 40) * 1000;

// ---------- PoW 求解（纯 JS，已验证 4/4 官方向量） ----------
const dspow = require('./ds-pow');

/**
 * 取 PoW 挑战并求解，返回可直接用的 x-ds-pow-response。
 * 求解约 1.5-6 秒（difficulty 144000），结果按 targetPath 缓存到过期前 30 秒。
 */
// PoW 是一次性的：DS 校验通过后该 header 立即失效。
// 所以只在"同一批并发"里去重，不做跨请求缓存。
const powInflight = new Map();  // "token|targetPath" -> Promise

async function getPowHeader(token, targetPath) {
    const key = token.slice(-12) + '|' + targetPath;
    if (powInflight.has(key)) return powInflight.get(key);

    const p = (async () => {
        const outer = await requestJson(token, 'POST', '/api/v0/chat/create_pow_challenge', { target_path: targetPath }, 30000);
        // 注意：challenge 数据是嵌套的 —— biz_data.challenge.{...}
        const ch = (outer && outer.challenge) ? outer.challenge : outer;
        if (!ch || !ch.challenge) throw new Error('取 PoW 挑战失败: ' + JSON.stringify(outer).slice(0, 200));
        const t0 = Date.now();
        const answer = dspow.solvePow(ch.challenge, ch.salt, ch.expire_at, ch.difficulty);
        if (answer < 0) throw new Error('PoW 无解');
        const header = dspow.buildPowHeader(ch, answer, targetPath);
        console.log('[pow] ' + targetPath + ' answer=' + answer + ' 耗时=' + (Date.now() - t0) + 'ms');
        return header;
    })().finally(() => powInflight.delete(key));

    powInflight.set(key, p);
    return p;
}
// ---------- HTTP 基础 ----------
function headersFor(token, extra) {
    return Object.assign({
        'authorization': 'Bearer ' + token,
        'accept': '*/*',
    }, CLIENT_HEADERS, extra || {});
}

async function requestJson(token, method, urlPath, body, timeoutMs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs || 60000);
    try {
        const r = await fetch(BASE + urlPath, {
            method,
            headers: headersFor(token, body ? { 'content-type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal,
        });
        const text = await r.text();
        if (r.status >= 400) throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 200));
        let j;
        try { j = JSON.parse(text); } catch (e) { throw new Error('非 JSON 响应: ' + text.slice(0, 200)); }
        if (!OK_CODES.has(j.code)) throw new Error('biz 错误 code=' + j.code + ' msg=' + (j.msg || ''));
        const data = j.data || {};
        if (!OK_CODES.has(data.biz_code)) throw new Error('biz 错误 biz_code=' + data.biz_code + ' msg=' + (data.biz_msg || ''));
        return data.biz_data;
    } finally { clearTimeout(t); }
}
// ---------- 会话 ----------
async function createSession(token) {
    const d = await requestJson(token, 'POST', '/api/v0/chat_session/create', {}, 30000);
    // 兼容两种返回：{chat_session:{id}} 和 {id}
    const id = (d && d.chat_session && d.chat_session.id) || (d && d.id);
    if (!id) throw new Error('建会话失败: ' + JSON.stringify(d).slice(0, 200));
    return id;
}

// ---------- 上传 ----------
async function uploadFile(token, name, buffer, mime, modelType) {
    const pow = await getPowHeader(token, TARGET_UPLOAD);
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name);
    const r = await fetch(BASE + TARGET_UPLOAD, {
        method: 'POST',
        headers: headersFor(token, {
            'x-ds-pow-response': pow,
            'x-file-size': String(buffer.length),
            'x-model-type': modelType || 'default',
            'x-thinking-enabled': '1',
        }),
        body: fd,
    });
    const text = await r.text();
    if (r.status >= 400) throw new Error('上传 HTTP ' + r.status + ': ' + text.slice(0, 200));
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('上传非 JSON: ' + text.slice(0, 200)); }
    if (!OK_CODES.has(j.code)) throw new Error('上传失败 code=' + j.code + ' ' + (j.msg || ''));
    const d = (j.data && j.data.biz_data) || {};
    if (!d.id) throw new Error('上传成功但没返回 id');
    return d.id;
}

/** 轮询文件状态到可解析 */
async function waitFileReady(token, fileId, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || FILE_WAIT_MS;
    while (Date.now() - t0 < limit) {
        try {
            const d = await requestJson(token, 'GET', '/api/v0/file/fetch_files?file_ids=' + encodeURIComponent(fileId), null, 20000);
            const f = d && d.files && d.files[0];
            if (f) {
                if (f.status === 'SUCCESS' || f.status === 'CONTENT_EMPTY') return true;
                if (['ERROR', 'REJECTED', 'CONTENT_FILTER'].includes(f.status)) {
                    throw new Error('文件处理失败: ' + f.status);
                }
            }
        } catch (e) {
            if (/文件处理失败/.test(e.message)) throw e;
        }
        await new Promise(r => setTimeout(r, FILE_POLL_MS));
    }
    throw new Error('文件处理超时');
}

// ---------- 对话（SSE 流式） ----------
/**
 * 流式对话。onEvent(type, delta)：
 *   'thinking' | 'content' | 'search_status' | 'status'
 * 返回 { content, thinking, messageId, tokens, citations }
 */
async function completion(opts) {
    const {
        token, sessionId, prompt, parentMessageId,
        thinkingEnabled, searchEnabled, refFileIds, onEvent, signal,
    } = opts;

    const pow = await getPowHeader(token, TARGET_COMPLETION);
    const body = {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId == null ? null : parentMessageId,
        model_type: 'default',
        prompt: prompt,
        ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
        thinking_enabled: !!thinkingEnabled,
        search_enabled: searchEnabled !== false,
    };

    const ac = new AbortController();
    if (signal) signal.addEventListener('abort', () => ac.abort());
    const stallTimer = setTimeout(() => ac.abort(), STALL_TIMEOUT_MS);

    const r = await fetch(BASE + TARGET_COMPLETION, {
        method: 'POST',
        headers: headersFor(token, { 'content-type': 'application/json', 'x-ds-pow-response': pow }),
        body: JSON.stringify(body),
        signal: ac.signal,
    });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        clearTimeout(stallTimer);
        throw new Error('对话 HTTP ' + r.status + ': ' + t.slice(0, 200));
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let thinking = '';
    let messageId = null;
    let tokens = 0;
    const citations = [];
    let finished = false;
    // 类型状态机：裸增量靠它判断归属
    let currentType = 'text';
    // 片段 ID -> 类型（DS 用 response/fragments/<id>/content 定位片段，
    // -1 表示"当前片段"，需要查表才知道它是 THINK 还是 RESPONSE）
    const fragmentTypes = new Map();
    let currentFragmentId = -1;   // 最后一个已知片段 id（-1 表示未知）

    const emit = (type, d) => { if (d && onEvent) onEvent(type, d); };

    while (!finished) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { break; }
        if (chunk.done) break;
        clearTimeout(stallTimer);
        stallTimer.refresh ? stallTimer.refresh() : null;
        buf += dec.decode(chunk.value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            let j;
            try { j = JSON.parse(raw); } catch (e) { continue; }

            if (j.response_message_id) messageId = j.response_message_id;
            if (j.v && typeof j.v === 'object' && j.v.response && j.v.response.message_id) {
                messageId = j.v.response.message_id;
            }
            if (j.error) throw new Error('DS 错误: ' + JSON.stringify(j.error).slice(0, 200));
            if (j.code === 'content_filter') throw new Error('内容被过滤');

            const p = typeof j.p === 'string' ? j.p : '';
            if (p === 'response/accumulated_token_usage') { tokens = Number(j.v) || tokens; continue; }
            // fragments 的 status 子路径（FINAL/DONE 之类）不是文本，跳过
            if (/^response\/fragments\/-?\d+\/status$/.test(p)) continue;
            if (p === 'response/search_status') { emit('search_status', j.v); continue; }
            if (p === 'response/status' || p === 'status') {
                if (typeof j.v === 'string' && j.v.toUpperCase() === 'FINISHED') { finished = true; break; }
                continue;
            }

            // 路径 → 类型映射（DS 有 4 种路径形态）：
            //   response/content                          正文
            //   response/thinking_content                 思考链
            //   response/fragments/<id>/content           按 id 查表定类型
            //   response/fragments/<id>/thinking_content  按 id 查表定类型
            if (p === 'response/content') { currentType = 'text'; }
            else if (p === 'response/thinking_content') { currentType = 'thinking'; }
            else {
                const fm = p.match(/^response\/fragments\/(-?\d+)\/(thinking_content|content)$/);
                if (fm) {
                    const raw = Number(fm[1]);
                    // -1 表示"当前片段"（即最后一次登记的那个 id）
                    const fid = raw < 0 ? currentFragmentId : raw;
                    // 后缀是 thinking_content 时优先级最高（强信号）
                    if (/\/thinking_content$/.test(p)) currentType = 'thinking';
                    else {
                        const known = fragmentTypes.get(fid);
                        if (known === 'thinking') currentType = 'thinking';
                        else if (known === 'text') currentType = 'text';
                        else currentType = 'text';
                    }
                }
            }

            // 取本次文本
            let text = null;
            if (typeof j.v === 'string') text = j.v;
            else if (Array.isArray(j.v)) {
                // response/fragments 形态：[{id, type, content}, ...]
                for (const frag of j.v) {
                    if (!frag || typeof frag !== 'object') continue;
                    const ty = String(frag.type || '').toUpperCase();
                    const isThink = (ty === 'THINK' || ty === 'THINKING');
                    // 登记片段类型 + 更新"当前片段"（-1 引用指向它）
                    if (typeof frag.id === 'number') {
                        fragmentTypes.set(frag.id, isThink ? 'thinking' : 'text');
                        currentFragmentId = frag.id;
                    }
                    const c = typeof frag.content === 'string' ? frag.content : '';
                    if (!c) continue;
                    if (isThink) { thinking += c; emit('thinking', c); }
                    else { content += c; emit('content', c); }
                }
                continue;
            } else if (j.v && typeof j.v === 'object') {
                // 首帧是完整快照，带 fragments 数组，每项有 type（RESPONSE / THINK）标明归属
                const rr = j.v.response || j.v;
                // 每次拿到快照都重新登记片段类型（正文片段出现后会新增 id）
                if (Array.isArray(rr.fragments) && rr.fragments.length) {
                    for (const frag of rr.fragments) {
                        if (!frag || typeof frag !== 'object') continue;
                        const ty = String(frag.type || '').toUpperCase();
                        const fc = typeof frag.content === 'string' ? frag.content : '';
                        // 关键：首帧快照里 fragments 带 type，必须同步 currentType，
                        // 否则后续没有 p 的裸增量会把思考内容错当正文。
                        if (typeof frag.id === 'number') {
                            const t = (ty === 'THINK' || ty === 'THINKING') ? 'thinking' : 'text';
                            fragmentTypes.set(frag.id, t);
                        }
                        if (ty === 'THINK' || ty === 'THINKING') {
                            currentType = 'thinking';
                            if (fc) { thinking += fc; emit('thinking', fc); }
                        } else {
                            currentType = 'text';
                            if (fc) { content += fc; emit('content', fc); }
                        }
                    }
                    // 数组最后一个就是"当前片段"，-1 引用指向它
                    for (const frag of rr.fragments) {
                        if (frag && typeof frag.id === 'number') currentFragmentId = frag.id;
                    }
                }
                // 也兼容直接给 content / thinking_content 的形态
                if (typeof rr.content === 'string' && rr.content && !(rr.fragments || []).length) {
                    content += rr.content; emit('content', rr.content);
                }
                if (typeof rr.thinking_content === 'string' && rr.thinking_content) {
                    thinking += rr.thinking_content; emit('thinking', rr.thinking_content);
                }
                // 首帧快照里也可能带 token 用量
                if (typeof rr.accumulated_token_usage === 'number' && rr.accumulated_token_usage) {
                    tokens = rr.accumulated_token_usage;
                }
                continue;
            }
            if (text == null || text === '') continue;
            if (text === 'FINISHED' && (!p || p === 'status')) { finished = true; break; }

            // 引用标记（联网搜索）
            if (/\[citation:\d+\]/.test(text)) citations.push(text);

            if (currentType === 'thinking') { thinking += text; emit('thinking', text); }
            else { content += text; emit('content', text); }
        }
    }
    clearTimeout(stallTimer);
    try { reader.cancel(); } catch (e) {}
    return { content, thinking, messageId, tokens, citations };
}

/** 删除会话 */
async function deleteSession(token, sessionId) {
    try {
        await requestJson(token, 'POST', '/api/v0/chat_session/delete', { chat_session_id: sessionId }, 20000);
        return true;
    } catch (e) { return false; }
}

module.exports = {
    BASE, CLIENT_HEADERS, TARGET_COMPLETION, TARGET_UPLOAD,
    createSession, uploadFile, waitFileReady, completion, deleteSession,
    getPowHeader, requestJson, headersFor,
};