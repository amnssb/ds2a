'use strict';
/**
 * src/ds-client.js — DeepSeek 原生 HTTP 协议客户端
 * 完美还原并增强官方逆向协议实现：
 *  - 完整 SSE 流式数据帧解析（支持 Array fragments、多片段引用、首帧快照与状态流）
 *  - 严格分离思考链 (thinking)、回答正文 (content)、联网搜索状态与引用 (citations)
 *  - 结合 WASM 硬件级 PoW 加速与滚动预热池
 *  - 独立安全 PoW 凭证（杜绝并发共享单次 PoW 导致的 400 失败）
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');
const powEngine = require('./pow-engine');
const logger = require('./logger');

const BASE = config.DEEPSEEK.BASE;
const TARGET_COMPLETION = config.DEEPSEEK.COMPLETION;
const TARGET_UPLOAD = config.DEEPSEEK.UPLOAD_FILE;

// 与官方 Web 客户端保持一致的请求头
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
const THINKING_STALL_TIMEOUT_MS = Number(process.env.DS_THINKING_STALL_TIMEOUT_S || 180) * 1000;
const FILE_POLL_MS = 400;
const FILE_WAIT_MS = Number(process.env.DS_FILE_WAIT_S || 40) * 1000;
const DS_DEBUG = process.env.DS_DEBUG === '1' || process.env.DS_DEBUG === 'true';

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
        });

        const text = await r.text();
        if (r.status >= 400) {
            throw new DeepSeekApiError(`HTTP ${r.status}: ${text.slice(0, 200)}`, r.status, null, urlPath);
        }

        let j;
        try {
            j = JSON.parse(text);
        } catch (e) {
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
/**
 * 获取一个可用的 PoW Header。
 * 每一个请求必须独占一个 PoW，绝不可多请求共享（否则 DS 校验会报一次性 Token 重复使用错误）。
 */
async function getPowHeader(token, targetPath) {
    // 1. 尝试从预热池获取已预计算好的 PoW（0ms 放行）
    const cached = powEngine.powPool.get(token, targetPath);
    if (cached) {
        logger.pow(`⚡ [PoW Hit] 命中预热缓存，0ms 放行！path=${targetPath}`);
        // 消费一个即在后台异步补充一个，保持池满
        prewarmPoW(token, targetPath).catch(() => {});
        return cached;
    }

    // 2. 无预热缓存时实时求解（单次独占）
    const outer = await requestJson(token, 'POST', config.DEEPSEEK.POW_CHALLENGE, { target_path: targetPath }, 30000);
    const ch = (outer && outer.challenge) ? outer.challenge : outer;
    if (!ch || !ch.challenge) {
        throw new DeepSeekApiError('取 PoW 挑战失败: ' + JSON.stringify(outer).slice(0, 200), 500, null, config.DEEPSEEK.POW_CHALLENGE);
    }

    const t0 = Date.now();
    const answer = powEngine.solve(ch);
    if (answer < 0) {
        throw new DeepSeekApiError('PoW 计算无解', 500, null, targetPath);
    }

    const header = powEngine.buildHeader(ch, answer, targetPath);
    logger.pow(`[PoW Solved] target=${targetPath} answer=${answer} 耗时=${Date.now() - t0}ms`);

    // 实时求解后，立即触发下一个预热，加速后续调用
    prewarmPoW(token, targetPath).catch(() => {});
    return header;
}

/**
 * 异步预热一个 PoW 并存入滚动池
 */
async function prewarmPoW(token, targetPath = TARGET_COMPLETION) {
    if (!config.POW_PREWARM_ENABLED) return;
    const pool = powEngine.powPool;

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
            logger.pow(`PoW 预热成功 [...${token.slice(-6)}] 池: ${pool.size(token, targetPath)}/${powEngine.POW_POOL_MAX}`);
        }
    } catch (e) {
        // 预热失败静默处理
    } finally {
        pool.decrementInflight(token, targetPath);
    }
}

// ---------- 会话管理 ----------
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

// ---------- 文件上传与等待 ----------
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
    try {
        j = JSON.parse(text);
    } catch (e) {
        throw new DeepSeekApiError(`上传响应非 JSON: ${text.slice(0, 200)}`, r.status, null, TARGET_UPLOAD);
    }

    if (!OK_CODES.has(j.code)) {
        throw new DeepSeekApiError(`上传失败 code=${j.code} msg=${j.msg || ''}`, r.status, j.code, TARGET_UPLOAD);
    }

    const d = (j.data && j.data.biz_data) || {};
    if (!d.id) throw new DeepSeekApiError('上传成功但未返回 file_id', 500, null, TARGET_UPLOAD);
    return d.id;
}

/** 轮询文件就绪状态 */
async function waitFileReady(token, fileId, timeoutMs = FILE_WAIT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const d = await requestJson(token, 'GET', `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`, null, 20000);
            const f = d && d.files && d.files[0];
            if (f) {
                if (f.status === 'SUCCESS' || f.status === 'CONTENT_EMPTY') return true;
                if (['ERROR', 'REJECTED', 'CONTENT_FILTER'].includes(f.status)) {
                    throw new DeepSeekApiError(`文件处理失败: ${f.status}`, 400);
                }
            }
        } catch (e) {
            if (/文件处理失败/.test(e.message)) throw e;
        }
        await new Promise(r => setTimeout(r, FILE_POLL_MS));
    }
    throw new DeepSeekApiError('文件处理超时，已放弃等待', 504);
}

// ---------- 核心流式对话 (SSE) ----------
/**
 * 对话调用（流式解析引擎）
 * @param {object} opts
 * @returns {Promise<{ content: string, thinking: string, messageId: string, tokens: number, citations: Array }>}
 */
async function completion(opts) {
    const {
        token,
        sessionId,
        prompt,
        parentMessageId,
        thinkingEnabled,
        searchEnabled,
        refFileIds,
        onEvent,
        signal,
    } = opts;

    const pow = await getPowHeader(token, TARGET_COMPLETION);
    const body = {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId == null ? null : parentMessageId,
        model_type: 'default',
        prompt,
        ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
        thinking_enabled: !!thinkingEnabled,
        search_enabled: searchEnabled !== false,
    };

    const ac = new AbortController();
    let userAborted = false;
    if (signal) {
        if (signal.aborted) userAborted = true;
        signal.addEventListener('abort', () => { userAborted = true; ac.abort(); });
    }
    const stallBudget = thinkingEnabled ? THINKING_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
    let stallTimer = null;
    let stalled = false;
    const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => { stalled = true; ac.abort(); }, stallBudget);
    };
    resetStall();

    try {
        const extraHeaders = {
            'content-type': 'application/json',
            'x-ds-pow-response': pow,
        };
        if (thinkingEnabled) extraHeaders['x-thinking-enabled'] = '1';

        let r;
        try {
            r = await fetch(BASE + TARGET_COMPLETION, {
                method: 'POST',
                headers: headersFor(token, extraHeaders),
                body: JSON.stringify(body),
                signal: ac.signal,
            });
        } catch (e) {
            const msg = String(e && e.message || e);
            if (stalled) {
                throw new DeepSeekApiError(`上游流式响应停滞超时 (${Math.round(stallBudget / 1000)}s)`, 504, null, TARGET_COMPLETION);
            }
            if (userAborted) {
                throw new DeepSeekApiError('客户端已中断请求', 499, null, TARGET_COMPLETION);
            }
            if (/abort|fetch failed|network|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(msg)) {
                throw new DeepSeekApiError(`上游网络异常: ${msg}`, 502, null, TARGET_COMPLETION);
            }
            throw e;
        }

        if (!r.ok) {
            const t = await r.text().catch(() => '');
            let j = null;
            try { j = JSON.parse(t); } catch (e) {}
            const bizCode = j && j.code;
            throw new DeepSeekApiError(`对话 HTTP ${r.status}: ${t.slice(0, 200)}`, r.status, bizCode, TARGET_COMPLETION);
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
        let sawAnyEvent = false;

        // 状态机：记录当前增量是属于正文还是思考链
        let currentType = 'text';
        // 片段 ID -> 类型（'thinking' | 'text'）
        const fragmentTypes = new Map();
        let currentFragmentId = -1;
        let abortedMidStream = false;

        const emit = (type, d) => {
            if (d && onEvent) onEvent(type, d);
        };

        const handleLine = (line) => {
            if (!line.startsWith('data:')) return;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') return;

            let j;
            try {
                j = JSON.parse(raw);
            } catch (e) {
                return;
            }

            sawAnyEvent = true;
            if (DS_DEBUG) {
                logger.info('[SSE] ' + JSON.stringify(j).slice(0, 500));
            }

            if (j.response_message_id) messageId = j.response_message_id;
            if (j.v && typeof j.v === 'object' && j.v.response && j.v.response.message_id) {
                messageId = j.v.response.message_id;
            }
            if (j.error) throw new DeepSeekApiError('DS 错误: ' + JSON.stringify(j.error).slice(0, 200), 500);
            if (j.code === 'content_filter') throw new DeepSeekApiError('内容被过滤', 400);

            const p = typeof j.p === 'string' ? j.p : '';
            if (p === 'response/accumulated_token_usage') {
                tokens = Number(j.v) || tokens;
                return;
            }
            if (/^response\/fragments\/-?\d+\/status$/.test(p)) return;
            if (p === 'response/search_status') {
                emit('search_status', j.v);
                return;
            }
            if (p === 'response/status' || p === 'status') {
                if (typeof j.v === 'string' && j.v.toUpperCase() === 'FINISHED') {
                    finished = true;
                }
                return;
            }

            // 路径 → 类型映射判断
            if (p === 'response/content') {
                currentType = 'text';
            } else if (p === 'response/thinking_content') {
                currentType = 'thinking';
            } else {
                const fm = p.match(/^response\/fragments\/(-?\d+)\/(thinking_content|content)$/);
                if (fm) {
                    const rawId = Number(fm[1]);
                    const fid = rawId < 0 ? currentFragmentId : rawId;
                    // thinking_content 后缀为强特征
                    if (/\/thinking_content$/.test(p)) {
                        currentType = 'thinking';
                    } else {
                        const known = fragmentTypes.get(fid);
                        currentType = known === 'thinking' ? 'thinking' : 'text';
                    }
                }
            }

            // 1. 处理数组形态的 fragments: [{ id, type, content }, ...]
            if (Array.isArray(j.v)) {
                for (const frag of j.v) {
                    if (!frag || typeof frag !== 'object') continue;
                    const ty = String(frag.type || '').toUpperCase();
                    const isThink = (ty === 'THINK' || ty === 'THINKING');
                    if (typeof frag.id === 'number') {
                        fragmentTypes.set(frag.id, isThink ? 'thinking' : 'text');
                        currentFragmentId = frag.id;
                    }
                    const c = typeof frag.content === 'string' ? frag.content : '';
                    if (!c) continue;
                    if (isThink) {
                        thinking += c;
                        emit('thinking', c);
                    } else {
                        content += c;
                        emit('content', c);
                    }
                }
                return;
            }

            // 2. 处理首帧或完整快照对象
            if (j.v && typeof j.v === 'object') {
                const rr = j.v.response || j.v;
                if (Array.isArray(rr.fragments) && rr.fragments.length) {
                    for (const frag of rr.fragments) {
                        if (!frag || typeof frag !== 'object') continue;
                        const ty = String(frag.type || '').toUpperCase();
                        const fc = typeof frag.content === 'string' ? frag.content : '';
                        const isThink = (ty === 'THINK' || ty === 'THINKING');
                        if (typeof frag.id === 'number') {
                            fragmentTypes.set(frag.id, isThink ? 'thinking' : 'text');
                            currentFragmentId = frag.id;
                        }
                        if (isThink) {
                            currentType = 'thinking';
                            if (fc) { thinking += fc; emit('thinking', fc); }
                        } else {
                            currentType = 'text';
                            if (fc) { content += fc; emit('content', fc); }
                        }
                    }
                } else if (typeof rr.content === 'string' && rr.content) {
                    // 即使 fragments 数组存在但为空，也允许直接取 content/thinking_content
                    content += rr.content;
                    emit('content', rr.content);
                }
                if (typeof rr.thinking_content === 'string' && rr.thinking_content) {
                    thinking += rr.thinking_content;
                    emit('thinking', rr.thinking_content);
                }
                if (typeof rr.accumulated_token_usage === 'number' && rr.accumulated_token_usage) {
                    tokens = rr.accumulated_token_usage;
                }
                return;
            }

            // 3. 处理常规文本增量
            let text = null;
            if (typeof j.v === 'string') text = j.v;
            if (text == null || text === '') return;
            if (text === 'FINISHED' && (!p || p === 'status')) {
                finished = true;
                return;
            }

            // 引用标记捕获
            if (/\[citation:\d+\]/.test(text)) citations.push(text);

            if (currentType === 'thinking') {
                thinking += text;
                emit('thinking', text);
            } else {
                content += text;
                emit('content', text);
            }
        };

        const drainBuf = () => {
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                handleLine(line);
                if (finished) {
                    // FINISHED 后继续冲刷同缓冲区内可能残留的正文帧
                    continue;
                }
            }
        };

        try {
            for (;;) {
                drainBuf();
                if (finished) break;

                let chunk;
                try {
                    chunk = await reader.read();
                } catch (e) {
                    abortedMidStream = true;
                    break;
                }
                if (chunk.done) break;
                resetStall();
                buf += dec.decode(chunk.value, { stream: true });
            }
            // 流结束后冲刷残留半行
            const tail = buf.trim();
            if (tail) {
                try { handleLine(tail); } catch (e) { throw e; }
            }
        } catch (e) {
            try { reader.cancel(); } catch (e2) {}
            throw e;
        }

        try { reader.cancel(); } catch (e) {}

        if (stalled && !content && !thinking) {
            throw new DeepSeekApiError(`上游流式响应停滞超时 (${Math.round(stallBudget / 1000)}s)`, 504, null, TARGET_COMPLETION);
        }
        if (userAborted) {
            throw new DeepSeekApiError('客户端已中断请求', 499, null, TARGET_COMPLETION);
        }
        if (abortedMidStream && !content && !thinking) {
            throw new DeepSeekApiError('上游流式连接中断且无内容', 502, null, TARGET_COMPLETION);
        }
        // 空回复：触发 failover 重试，而不是静默返回 200 空正文
        if (!content && !thinking) {
            const hint = sawAnyEvent ? '收到事件但未解析到正文/思考内容' : '未收到任何 SSE 事件';
            if (DS_DEBUG) logger.warn(`[SSE Empty] ${hint} finished=${finished} tokens=${tokens}`);
            throw new DeepSeekApiError(`上游返回空响应 (${hint})`, 502, null, TARGET_COMPLETION);
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
