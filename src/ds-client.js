'use strict';
/**
 * src/ds-client.js — 优化的 DeepSeek 原生 HTTP 客户端
 * - Keep-Alive 连接池复用，降低并发 TCP/TLS 握手延迟
 * - 结合 WASM PoW 引擎与预热缓存（命中预热 0ms 启动）
 * - 详细业务错误码透传（40003 invalid token 等），供上层调度器精准熔断
 */
const https = require('https');
const config = require('./config');
const powEngine = require('./pow-engine');
const logger = require('./logger');

const BASE = config.DEEPSEEK.BASE;
const TARGET_COMPLETION = config.DEEPSEEK.COMPLETION;
const TARGET_UPLOAD = config.DEEPSEEK.UPLOAD_FILE;

// 全局 Keep-Alive Agent（支持高并发复用连接，避免低配环境频繁握手）
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 100,
    maxFreeSockets: 25,
    timeout: 60000,
});

const CLIENT_HEADERS = {
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    'referer': BASE + '/a/chat/',
    'origin': BASE,
    'user-agent': config.DEEPSEEK.USER_AGENT,
};

const OK_CODES = new Set([0, null, undefined]);
const STALL_TIMEOUT_MS = Number(process.env.DS_STALL_TIMEOUT_S || 90) * 1000;
const FILE_WAIT_MS = Number(process.env.DS_FILE_WAIT_S || 40) * 1000;

class DeepSeekApiError extends Error {
    constructor(message, statusCode = 500, bizCode = null, endpoint = '') {
        super(message);
        this.name = 'DeepSeekApiError';
        this.statusCode = statusCode;
        this.bizCode = bizCode;
        this.endpoint = endpoint;
    }
}

function headersFor(token, extra) {
    return Object.assign({
        'authorization': 'Bearer ' + token,
        'accept': '*/*',
    }, CLIENT_HEADERS, extra || {});
}

async function requestJson(token, method, urlPath, body, timeoutMs = 60000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(BASE + urlPath, {
            method,
            headers: headersFor(token, body ? { 'content-type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal,
            // @ts-ignore
            dispatcher: undefined, // fetch 在 Node.js 环境下走原生底层
        });

        const text = await r.text();
        if (r.status >= 400) {
            throw new DeepSeekApiError(`HTTP ${r.status}: ${text.slice(0, 200)}`, r.status, null, urlPath);
        }

        let j;
        try { j = JSON.parse(text); }
        catch (e) {
            throw new DeepSeekApiError(`非 JSON 响应: ${text.slice(0, 200)}`, r.status, null, urlPath);
        }

        if (!OK_CODES.has(j.code)) {
            throw new DeepSeekApiError(`biz 错误 code=${j.code} msg=${j.msg || ''}`, r.status, j.code, urlPath);
        }

        const data = j.data || {};
        if (!OK_CODES.has(data.biz_code)) {
            throw new DeepSeekApiError(`biz 错误 biz_code=${data.biz_code} msg=${data.biz_msg || ''}`, r.status, data.biz_code, urlPath);
        }

        return data.biz_data;
    } finally {
        clearTimeout(t);
    }
}

// ---------- PoW 挑战求解与预热 ----------
const powInflight = new Map(); // 并发防抖：同账号同路径最多 1 个实时求解请求

async function getPowHeader(token, targetPath) {
    // 1. 尝试从预热池取（0ms）
    const cached = powEngine.powPool.get(token, targetPath);
    if (cached) {
        const remaining = powEngine.powPool.size(token, targetPath);
        logger.pow(`⚡ [PoW Hit] 命中预热缓存，0ms 放行！剩余池: ${remaining}/${powEngine.POW_POOL_MAX} path=${targetPath}`);
        // 消费一个 → 立即异步补充一个，保持池满
        prewarmPoW(token, targetPath).catch(() => {});
        return cached;
    }

    // 2. 并发合并防抖：同账号同路径的多个并发请求共享一次求解，避免重复打 PoW 接口
    const key = token.slice(-12) + '|' + targetPath;
    if (powInflight.has(key)) {
        logger.pow(`[PoW Dedup] 合并等待已有在途求解... path=${targetPath}`);
        return powInflight.get(key);
    }

    const p = (async () => {
        const outer = await requestJson(token, 'POST', config.DEEPSEEK.POW_CHALLENGE, { target_path: targetPath }, 30000);
        const ch = (outer && outer.challenge) ? outer.challenge : outer;
        if (!ch || !ch.challenge) {
            throw new DeepSeekApiError('取 PoW 挑战失败: ' + JSON.stringify(outer).slice(0, 200), 500, null, config.DEEPSEEK.POW_CHALLENGE);
        }
        const answer = powEngine.solve(ch);
        if (answer < 0) throw new DeepSeekApiError('PoW 计算无解', 500, null, targetPath);

        const header = powEngine.buildHeader(ch, answer, targetPath);
        // 实时求解完成 → 立即异步为下一个请求预热，尽快将池填满
        prewarmPoW(token, targetPath).catch(() => {});
        return header;
    })().finally(() => powInflight.delete(key));

    powInflight.set(key, p);
    return p;
}

/**
 * 异步预热一个 PoW 并存入滚动池。
 * 核心设计：JS 单线程，check + incrementInflight 是原子操作，不存在竞争。
 * 若「当前有效缓存 + 在途预热」已 >= POW_POOL_MAX，直接返回（幂等安全）。
 */
async function prewarmPoW(token, targetPath = TARGET_COMPLETION) {
    if (!config.POW_PREWARM_ENABLED) return;
    const pool = powEngine.powPool;

    // 原子判断：已有 + 在途 是否已满（单线程保证此处不会竞争）
    const available = pool.size(token, targetPath) + pool.inflightCount(token, targetPath);
    if (available >= powEngine.POW_POOL_MAX) return;

    pool.incrementInflight(token, targetPath);
    try {
        const outer = await requestJson(token, 'POST', config.DEEPSEEK.POW_CHALLENGE, { target_path: targetPath }, 30000);
        const ch = (outer && outer.challenge) ? outer.challenge : outer;
        if (!ch || !ch.challenge) return;
        const answer = powEngine.solve(ch);
        if (answer >= 0) {
            const header = powEngine.buildHeader(ch, answer, targetPath);
            const expireAt = ch.expire_at ? Number(ch.expire_at) * 1000 : (Date.now() + 300000);
            pool.put(token, targetPath, header, expireAt);
            logger.pow(`PoW 预热成功 [...${token.slice(-6)}] 池: ${pool.size(token, targetPath)}/${powEngine.POW_POOL_MAX} path=${targetPath}`);
        }
    } catch (e) {
        // 预热失败静默处理，不影响主流程
    } finally {
        pool.decrementInflight(token, targetPath);
    }
}

// ---------- 业务接口 ----------
async function createSession(token) {
    const d = await requestJson(token, 'POST', config.DEEPSEEK.CREATE_SESSION, {}, 30000);
    const id = (d && d.chat_session && d.chat_session.id) || (d && d.id);
    if (!id) {
        throw new DeepSeekApiError('创建会话失败: ' + JSON.stringify(d).slice(0, 200), 500, null, config.DEEPSEEK.CREATE_SESSION);
    }
    return id;
}

async function deleteSession(token, sessionId) {
    if (!sessionId) return false;
    try {
        await requestJson(token, 'POST', config.DEEPSEEK.DELETE_SESSION, { chat_session_id: sessionId }, 15000);
        return true;
    } catch (e) {
        return false;
    }
}

async function uploadFile(token, name, buffer, mime, modelType = 'default') {
    const pow = await getPowHeader(token, TARGET_UPLOAD);
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name);

    const r = await fetch(BASE + TARGET_UPLOAD, {
        method: 'POST',
        headers: headersFor(token, {
            'x-ds-pow-response': pow,
            'x-file-size': String(buffer.length),
            'x-model-type': modelType,
            'x-thinking-enabled': '1',
        }),
        body: fd,
    });

    const text = await r.text();
    if (r.status >= 400) {
        throw new DeepSeekApiError(`上传 HTTP ${r.status}: ${text.slice(0, 200)}`, r.status, null, TARGET_UPLOAD);
    }

    let j;
    try { j = JSON.parse(text); } catch (e) { throw new DeepSeekApiError('上传非 JSON', r.status); }
    if (!OK_CODES.has(j.code)) {
        throw new DeepSeekApiError(`上传失败 code=${j.code} ${j.msg || ''}`, r.status, j.code, TARGET_UPLOAD);
    }
    const d = (j.data && j.data.biz_data) || {};
    if (!d.id) throw new DeepSeekApiError('上传成功但未返回 id', 500);
    return d.id;
}

async function waitFileReady(token, fileId, timeoutMs = FILE_WAIT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const list = await requestJson(token, 'POST', config.DEEPSEEK.FILE_STATUS, { file_ids: [fileId] }, 10000);
            const item = Array.isArray(list) ? list.find(x => x.id === fileId) : list;
            if (item) {
                const s = String(item.status || item.parse_status || '').toUpperCase();
                if (s === 'SUCCESS' || s === 'COMPLETED' || s === 'PARSED') return item;
                if (s === 'FAILED' || s === 'ERROR') throw new DeepSeekApiError('文件解析失败: ' + (item.error || s), 500);
            }
        } catch (e) {
            if (e instanceof DeepSeekApiError && e.statusCode >= 400) throw e;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    throw new DeepSeekApiError(`等待文件解析超时 (${timeoutMs}ms)`, 504);
}

/**
 * 流式对话
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
    let stallTimer = null;

    // 将外部 abort 信号传入内部 ac
    if (signal) {
        if (signal.aborted) { ac.abort(); }
        else { signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    }

    function resetStall() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ac.abort(), STALL_TIMEOUT_MS);
        if (stallTimer.unref) stallTimer.unref();
    }
    resetStall();

    let reader;
    try {
    const r = await fetch(BASE + TARGET_COMPLETION, {
        method: 'POST',
        headers: headersFor(token, { 'content-type': 'application/json', 'x-ds-pow-response': pow }),
        body: JSON.stringify(body),
        signal: ac.signal,
    });

    if (!r.ok) {
        const t = await r.text().catch(() => '');
        let bizCode = null;
        try {
            const j = JSON.parse(t);
            bizCode = j.code || (j.data && j.data.biz_code);
        } catch (e) {}
        throw new DeepSeekApiError(`对话 HTTP ${r.status}: ${t.slice(0, 200)}`, r.status, bizCode, TARGET_COMPLETION);
    }

    reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let thinking = '';
    let messageId = null;
    let tokens = 0;
    const citations = [];
    let finished = false;
    let currentType = 'text';
    const fragmentTypes = new Map();
    let currentFragmentId = -1;

    const emit = (type, d) => { if (d && onEvent) onEvent(type, d); };

    while (!finished) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { break; }
        if (chunk.done) break;
        resetStall(); // 每收到数据就重置超时
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
            if (j.error) throw new DeepSeekApiError('DS 错误: ' + JSON.stringify(j.error).slice(0, 200), 500);
            if (j.code === 'content_filter') throw new DeepSeekApiError('内容被过滤', 400);

            const p = typeof j.p === 'string' ? j.p : '';
            if (p === 'response/accumulated_token_usage') { tokens = Number(j.v) || tokens; continue; }
            if (/^response\/fragments\/-?\d+\/status$/.test(p)) continue;
            if (p === 'response/search_status') { emit('search_status', j.v); continue; }
            if (p === 'response/status' || p === 'status') {
                if (typeof j.v === 'string' && j.v.toUpperCase() === 'FINISHED') { finished = true; break; }
                continue;
            }

            if (p === 'response/content') { currentType = 'text'; }
            else if (p === 'response/thinking_content') { currentType = 'thinking'; }
            else {
                const fm = p.match(/^response\/fragments\/(-?\d+)\/(thinking_content|content)$/);
                if (fm) {
                    const fid = Number(fm[1]);
                    const field = fm[2];
                    if (fid >= 0) {
                        currentFragmentId = fid;
                        currentType = field === 'thinking_content' ? 'thinking' : 'text';
                        fragmentTypes.set(fid, currentType);
                    } else if (fid === -1) {
                        if (currentFragmentId >= 0 && fragmentTypes.has(currentFragmentId)) {
                            currentType = fragmentTypes.get(currentFragmentId);
                        } else {
                            currentType = field === 'thinking_content' ? 'thinking' : 'text';
                        }
                    }
                }
            }

            if (p.startsWith('response/citations') && Array.isArray(j.v)) {
                for (const c of j.v) if (c && c.url) citations.push(c);
                continue;
            }

            if (!p && j.v && typeof j.v === 'object' && j.v.response && Array.isArray(j.v.response.fragments)) {
                for (const frag of j.v.response.fragments) {
                    if (frag && typeof frag.id === 'number') {
                        currentFragmentId = frag.id;
                        const t = String(frag.type || '').toUpperCase();
                        const mapped = t === 'THINK' ? 'thinking' : 'text';
                        fragmentTypes.set(frag.id, mapped);
                        currentType = mapped;
                        const txt = frag.content || '';
                        if (txt) {
                            if (mapped === 'thinking') { thinking += txt; emit('thinking', txt); }
                            else { content += txt; emit('content', txt); }
                        }
                    }
                }
                continue;
            }

            let delta = '';
            if (typeof j.v === 'string') delta = j.v;
            else if (j.v && typeof j.v.text === 'string') delta = j.v.text;

            if (delta) {
                if (currentType === 'thinking') { thinking += delta; emit('thinking', delta); }
                else { content += delta; emit('content', delta); }
            }
        }
    }

    return { content, thinking, messageId, tokens, citations };
    } finally {
        if (stallTimer) clearTimeout(stallTimer);
    }
}

module.exports = {
    DeepSeekApiError,
    createSession,
    deleteSession,
    uploadFile,
    waitFileReady,
    completion,
    getPowHeader,
    prewarmPoW,
};
