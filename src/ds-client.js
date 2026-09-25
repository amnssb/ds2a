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

const net = require('net');
const tls = require('tls');

// ---------- 账号级独立代理（HTTP/HTTPS/SOCKS5） ----------
let ProxyAgentClass = null;
let AgentClass = null;
try {
    const undici = require('undici');
    ProxyAgentClass = undici.ProxyAgent;
    AgentClass = undici.Agent;
} catch (e) {
    ProxyAgentClass = null;
    AgentClass = null;
}
const _dispatcherCache = new Map();

function resolveProxyUrl(proxy) {
    let p = String(proxy || '').trim();
    if (!p) p = String(config.DEFAULT_PROXY || '').trim();
    if (!p) return '';
    // 若未填协议头，自动补全 http://
    if (!/^[a-zA-Z0-9]+:\/\//.test(p)) {
        p = 'http://' + p;
    }
    // 容器内环境优化：若在 Docker 容器内且指向 127.0.0.1 或 localhost，自动映射为宿主机 host.docker.internal
    if (process.env.DOCKER_CONTAINER === '1' || fs.existsSync('/.dockerenv')) {
        try {
            const u = new URL(p);
            if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
                u.hostname = process.env.HOST_GATEWAY_NAME || 'host.docker.internal';
                p = u.toString();
            }
        } catch (e) {}
    }
    return p;
}

function createSocks5Connector(socksUrlStr) {
    let u;
    try { u = new URL(socksUrlStr); } catch (e) { return null; }
    const socksHost = u.hostname;
    const socksPort = Number(u.port) || 1080;
    const authUser = u.username ? decodeURIComponent(u.username) : '';
    const authPass = u.password ? decodeURIComponent(u.password) : '';

    return function connect(opts, callback) {
        const targetHost = opts.hostname;
        const targetPort = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
        const isHttps = opts.protocol === 'https:' || targetPort === 443;

        const socket = net.connect({ host: socksHost, port: socksPort });
        let stage = 0;
        let buf = Buffer.alloc(0);

        const cleanup = () => {
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
        };

        socket.once('error', (err) => {
            cleanup();
            callback(err, null);
        });

        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (stage === 0) {
                if (buf.length < 2) return;
                const ver = buf[0];
                const method = buf[1];
                buf = buf.subarray(2);
                if (ver !== 5) {
                    cleanup();
                    socket.destroy();
                    return callback(new Error('SOCKS5 协议版本错误: ' + ver), null);
                }
                if (method === 0x02) {
                    stage = 1;
                    const uBuf = Buffer.from(authUser, 'utf8');
                    const pBuf = Buffer.from(authPass, 'utf8');
                    const authReq = Buffer.concat([
                        Buffer.from([0x01, uBuf.length]),
                        uBuf,
                        Buffer.from([pBuf.length]),
                        pBuf
                    ]);
                    socket.write(authReq);
                    return;
                } else if (method === 0x00) {
                    sendConnectReq();
                    return;
                } else {
                    cleanup();
                    socket.destroy();
                    return callback(new Error('SOCKS5 代理认证方式不支持: ' + method), null);
                }
            }
            if (stage === 1) {
                if (buf.length < 2) return;
                const status = buf[1];
                buf = buf.subarray(2);
                if (status !== 0) {
                    cleanup();
                    socket.destroy();
                    return callback(new Error('SOCKS5 认证失败'), null);
                }
                sendConnectReq();
                return;
            }
            if (stage === 2) {
                if (buf.length < 4) return;
                const rep = buf[1];
                const atyp = buf[3];
                let minLen = 4;
                if (atyp === 1) minLen += 4 + 2;
                else if (atyp === 3) minLen += 1 + (buf.length > 4 ? buf[4] : 0) + 2;
                else if (atyp === 4) minLen += 16 + 2;
                if (buf.length < minLen) return;

                cleanup();
                if (rep !== 0) {
                    socket.destroy();
                    return callback(new Error('SOCKS5 代理连接目标失败, rep=' + rep), null);
                }

                if (buf.length > minLen) {
                    const rest = buf.subarray(minLen);
                    socket.unshift(rest);
                }

                if (isHttps) {
                    const tlsSocket = tls.connect({
                        socket,
                        servername: targetHost,
                        rejectUnauthorized: true,
                    });
                    tlsSocket.once('error', (err) => callback(err, null));
                    tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
                } else {
                    callback(null, socket);
                }
            }
        });

        function sendConnectReq() {
            stage = 2;
            const hostBuf = Buffer.from(targetHost, 'utf8');
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort, 0);
            const req = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                hostBuf,
                portBuf
            ]);
            socket.write(req);
        }

        const hasAuth = !!(authUser || authPass);
        const greeting = hasAuth
            ? Buffer.from([0x05, 0x02, 0x00, 0x02])
            : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(greeting);
    };
}

function dispatcherFor(proxy) {
    const url = resolveProxyUrl(proxy);
    if (!url) return undefined;
    let agent = _dispatcherCache.get(url);
    if (!agent) {
        if (/^socks5h?:\/\//i.test(url) && AgentClass) {
            const connector = createSocks5Connector(url);
            if (connector) {
                agent = new AgentClass({ connect: connector });
            }
        } else if (ProxyAgentClass) {
            agent = new ProxyAgentClass(url);
        }
        if (agent) _dispatcherCache.set(url, agent);
    }
    return agent;
}

function withProxy(proxy, opts) {
    const d = dispatcherFor(proxy);
    return d ? Object.assign({}, opts, { dispatcher: d }) : opts;
}

/** PoW 池键：同 token 不同出口 IP 不能混用 */
function powCacheKey(token, proxy) {
    const p = resolveProxyUrl(proxy);
    return p ? (token + '@@' + p) : token;
}

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

async function requestJson(token, method, urlPath, body, timeoutMs = 60000, proxy = '') {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(BASE + urlPath, withProxy(proxy, {
            method,
            headers: headersFor(token, body ? { 'content-type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal,
        }));

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
async function getPowHeader(token, targetPath, proxy = '') {
    const cacheKey = powCacheKey(token, proxy);
    // 1. 尝试从预热池获取已预计算好的 PoW（0ms 放行）
    const cached = powEngine.powPool.get(cacheKey, targetPath);
    if (cached) {
        logger.pow(`⚡ [PoW Hit] 命中预热缓存，0ms 放行！path=${targetPath}`);
        // 消费一个即在后台异步补充一个，保持池满
        prewarmPoW(token, targetPath, proxy).catch(() => {});
        return cached;
    }

    // 2. 无预热缓存时实时求解（单次独占）
    const outer = await requestJson(token, 'POST', config.DEEPSEEK.POW_CHALLENGE, { target_path: targetPath }, 30000, proxy);
    const ch = (outer && outer.challenge) ? outer.challenge : outer;
    if (!ch || !ch.challenge) {
        throw new DeepSeekApiError('取 PoW 挑战失败: ' + JSON.stringify(outer).slice(0, 200), 500, null, config.DEEPSEEK.POW_CHALLENGE);
    }

    const t0 = Date.now();
    const answer = await powEngine.solve(ch);
    if (answer < 0) {
        throw new DeepSeekApiError('PoW 计算无解', 500, null, targetPath);
    }

    const header = powEngine.buildHeader(ch, answer, targetPath);
    logger.pow(`[PoW Solved] target=${targetPath} answer=${answer} 耗时=${Date.now() - t0}ms`);

    // 实时求解后，立即触发下一个预热，加速后续调用
    prewarmPoW(token, targetPath, proxy).catch(() => {});
    return header;
}

/**
 * 异步预热一个 PoW 并存入滚动池
 */
async function prewarmPoW(token, targetPath = TARGET_COMPLETION, proxy = '') {
    if (!config.POW_PREWARM_ENABLED) return;
    const pool = powEngine.powPool;
    const cacheKey = powCacheKey(token, proxy);

    const available = pool.size(cacheKey, targetPath) + pool.inflightCount(cacheKey, targetPath);
    if (available >= powEngine.POW_POOL_MAX) return;

    pool.incrementInflight(cacheKey, targetPath);
    try {
        const outer = await requestJson(token, 'POST', config.DEEPSEEK.POW_CHALLENGE, { target_path: targetPath }, 30000, proxy);
        const ch = (outer && outer.challenge) ? outer.challenge : outer;
        if (!ch || !ch.challenge) return;
        const answer = await powEngine.solve(ch);
        if (answer >= 0) {
            const header = powEngine.buildHeader(ch, answer, targetPath);
            const expireAt = ch.expire_at ? Number(ch.expire_at) * 1000 : (Date.now() + 300000);
            pool.put(cacheKey, targetPath, header, expireAt);
            logger.pow(`PoW 预热成功 [...${token.slice(-6)}] 池: ${pool.size(cacheKey, targetPath)}/${powEngine.POW_POOL_MAX}`);
        }
    } catch (e) {
        // 预热失败静默处理
    } finally {
        pool.decrementInflight(cacheKey, targetPath);
    }
}

// ---------- 会话管理 ----------
async function createSession(token, proxy = '') {
    const d = await requestJson(token, 'POST', config.DEEPSEEK.CREATE_SESSION, {}, 30000, proxy);
    const id = (d && d.chat_session && d.chat_session.id) || (d && d.id);
    if (!id) {
        throw new DeepSeekApiError('创建会话失败: ' + JSON.stringify(d).slice(0, 200), 500, null, config.DEEPSEEK.CREATE_SESSION);
    }
    return id;
}

async function deleteSession(token, sessionId, proxy = '') {
    if (!sessionId) return false;
    try {
        await requestJson(token, 'POST', config.DEEPSEEK.DELETE_SESSION, { chat_session_id: sessionId }, 15000, proxy);
        return true;
    } catch (e) {
        return false;
    }
}

// ---------- 文件上传与等待 ----------
async function uploadFile(token, name, buffer, mime, modelType = 'default', proxy = '') {
    const pow = await getPowHeader(token, TARGET_UPLOAD, proxy);
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name);

    const r = await fetch(BASE + TARGET_UPLOAD, withProxy(proxy, {
        method: 'POST',
        headers: headersFor(token, {
            'x-ds-pow-response': pow,
            'x-file-size': String(buffer.length),
            'x-model-type': modelType,
            'x-thinking-enabled': '1',
        }),
        body: fd,
    }));

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
async function waitFileReady(token, fileId, timeoutMs = FILE_WAIT_MS, proxy = '') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const d = await requestJson(token, 'GET', `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`, null, 20000, proxy);
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
        proxy,
    } = opts;

    const pow = await getPowHeader(token, TARGET_COMPLETION, proxy);
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
            r = await fetch(BASE + TARGET_COMPLETION, withProxy(proxy, {
                method: 'POST',
                headers: headersFor(token, extraHeaders),
                body: JSON.stringify(body),
                signal: ac.signal,
            }));
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
            const bizCode = j && (j.data && j.data.biz_code != null ? j.data.biz_code : j.code);
            throw new DeepSeekApiError(`对话 HTTP ${r.status}: ${t.slice(0, 200)}`, r.status, bizCode, TARGET_COMPLETION);
        }

        // 检查 Content-Type：若上游返回 application/json，说明发生业务拦截（如 user is muted，biz_code=5）
        const contentType = String(r.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
            const t = await r.text().catch(() => '');
            let j = null;
            try { j = JSON.parse(t); } catch (e) {}
            if (j) {
                const bizCode = (j.data && j.data.biz_code != null) ? j.data.biz_code : j.code;
                const bizMsg = (j.data && j.data.biz_msg) || j.msg || JSON.stringify(j);
                throw new DeepSeekApiError(`DeepSeek 业务拦截 [bizCode=${bizCode}]: ${bizMsg}`, 403, bizCode, TARGET_COMPLETION);
            }
            throw new DeepSeekApiError(`对话非流式响应: ${t.slice(0, 200)}`, 502, null, TARGET_COMPLETION);
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
        let thinkingFinished = false; // 标记思考阶段是否已明确完成
        let abortedMidStream = false;

        const emit = (type, d) => {
            if (d && onEvent) onEvent(type, d);
        };

        const handleParsed = (j) => {
            if (!j || typeof j !== 'object') return;

            if (j.response_message_id) messageId = j.response_message_id;
            if (j.v && typeof j.v === 'object' && j.v.response && j.v.response.message_id) {
                messageId = j.v.response.message_id;
            }
            if (j.error) throw new DeepSeekApiError('DS 错误: ' + JSON.stringify(j.error).slice(0, 200), 500);
            if (j.code === 'content_filter') throw new DeepSeekApiError('内容被过滤', 400);

            const p = typeof j.p === 'string' ? j.p : '';

            // 0. BATCH 批处理解包：递归处理批处理命令集（如 status, tokens 等）
            if (j.o === 'BATCH' && Array.isArray(j.v)) {
                for (const item of j.v) {
                    if (!item || typeof item !== 'object') continue;
                    const subP = item.p ? (p ? `${p}/${item.p}` : item.p) : p;
                    handleParsed({ ...item, p: subP });
                }
                return;
            }

            if (p === 'response/accumulated_token_usage' || p === 'accumulated_token_usage') {
                tokens = Number(j.v) || tokens;
                return;
            }

            // 片段状态判断：若思考片段（通常为 fragment 0）结束，标记思考完成，切换为正文模式
            const fragStatusMatch = p.match(/^response\/fragments\/(-?\d+)\/status$/);
            if (fragStatusMatch) {
                const sFid = Number(fragStatusMatch[1]);
                const st = typeof j.v === 'string' ? j.v.toUpperCase() : '';
                if (st === 'FINISHED') {
                    if (sFid === 0 || fragmentTypes.get(sFid) === 'thinking') {
                        thinkingFinished = true;
                        currentType = 'text';
                    }
                }
                return;
            }

            if (p === 'response/search_status' || p === 'search_status') {
                emit('search_status', j.v);
                return;
            }

            // quasi_status 为 DeepSeek 阶段性准状态（如思考结束时发送 FINISHED），代表思考完成，绝对不是整个响应结束！
            if (p === 'response/quasi_status' || p === 'quasi_status') {
                if (typeof j.v === 'string' && j.v.toUpperCase() === 'FINISHED') {
                    thinkingFinished = true;
                    currentType = 'text';
                }
                return;
            }

            // 只有整条响应的根状态 finished 才代表模型输出全部完毕
            if (p === 'response/status' || p === 'status') {
                if (typeof j.v === 'string' && j.v.toUpperCase() === 'FINISHED') {
                    finished = true;
                }
                return;
            }

            // 1. 处理数组形态的 fragments: [{ id, type, content }, ...] (如 response/fragments APPEND)
            if (Array.isArray(j.v)) {
                // 若数组项是 BATCH 风格的 { p, v }，转入逐项处理
                if (j.v.length > 0 && j.v[0] && typeof j.v[0].p === 'string') {
                    for (const item of j.v) {
                        if (!item || typeof item !== 'object') continue;
                        const subP = item.p ? (p ? `${p}/${item.p}` : item.p) : p;
                        handleParsed({ ...item, p: subP });
                    }
                    return;
                }
                for (const frag of j.v) {
                    if (!frag || typeof frag !== 'object') continue;
                    const ty = String(frag.type || '').toUpperCase();
                    const isThink = (ty === 'THINK' || ty === 'THINKING');
                    if (typeof frag.id === 'number') {
                        currentFragmentId = frag.id;
                        fragmentTypes.set(frag.id, isThink ? 'thinking' : 'text');
                    }
                    if (isThink && !thinkingFinished) {
                        currentType = 'thinking';
                    } else if (ty || thinkingFinished) {
                        // 一旦出现明确的正文片段类型（如 RESPONSE/TEXT），思考彻底完成
                        thinkingFinished = true;
                        currentType = 'text';
                    }
                    const c = typeof frag.content === 'string' ? frag.content : '';
                    if (!c) continue;
                    if (currentType === 'thinking' && !thinkingFinished) {
                        thinking += c;
                        emit('thinking', c);
                    } else {
                        content += c;
                        emit('content', c);
                    }
                }
                return;
            }

            // 2. 处理完整快照对象或单个 fragment 对象
            if (j.v && typeof j.v === 'object') {
                const rr = j.v.response || j.v;
                let gotThinkFromFragments = false;
                if (Array.isArray(rr.fragments) && rr.fragments.length) {
                    for (const frag of rr.fragments) {
                        if (!frag || typeof frag !== 'object') continue;
                        const ty = String(frag.type || '').toUpperCase();
                        const fc = typeof frag.content === 'string' ? frag.content : '';
                        const isThink = (ty === 'THINK' || ty === 'THINKING');
                        if (typeof frag.id === 'number') {
                            currentFragmentId = frag.id;
                            fragmentTypes.set(frag.id, isThink ? 'thinking' : 'text');
                        }
                        if (isThink && !thinkingFinished) {
                            currentType = 'thinking';
                            if (fc) { gotThinkFromFragments = true; thinking += fc; emit('thinking', fc); }
                        } else {
                            thinkingFinished = true;
                            currentType = 'text';
                            if (fc) { content += fc; emit('content', fc); }
                        }
                    }
                } else if (typeof rr.type === 'string') {
                    // 单个 fragment 对象 (如 {"p":"response/fragments/0", "v":{"id":0, "type":"THINK"}})
                    const ty = String(rr.type).toUpperCase();
                    const isThink = (ty === 'THINK' || ty === 'THINKING');
                    if (typeof rr.id === 'number') {
                        currentFragmentId = rr.id;
                        fragmentTypes.set(rr.id, isThink ? 'thinking' : 'text');
                    }
                    if (isThink && !thinkingFinished) {
                        currentType = 'thinking';
                    } else {
                        thinkingFinished = true;
                        currentType = 'text';
                    }
                    const fc = typeof rr.content === 'string' ? rr.content : '';
                    if (fc) {
                        if (currentType === 'thinking' && !thinkingFinished) { thinking += fc; emit('thinking', fc); }
                        else { content += fc; emit('content', fc); }
                    }
                } else {
                    if (typeof rr.content === 'string' && rr.content) {
                        content += rr.content;
                        emit('content', rr.content);
                    }
                    if (typeof rr.text === 'string' && rr.text) {
                        content += rr.text;
                        emit('content', rr.text);
                    }
                }
                if (!gotThinkFromFragments && typeof rr.thinking_content === 'string' && rr.thinking_content) {
                    thinking += rr.thinking_content;
                    emit('thinking', rr.thinking_content);
                }
                if (typeof rr.accumulated_token_usage === 'number' && rr.accumulated_token_usage) {
                    tokens = rr.accumulated_token_usage;
                }
                return;
            }

            // 3. 检查单字段片段类型更新 (如 {"p":"response/fragments/0/type", "v":"RESPONSE"})
            const typeMatch = p.match(/^response\/fragments\/(-?\d+)\/type$/);
            if (typeMatch && typeof j.v === 'string') {
                const rawId = Number(typeMatch[1]);
                const ty = j.v.toUpperCase();
                const isThink = (ty === 'THINK' || ty === 'THINKING');
                if (rawId >= 0) {
                    currentFragmentId = rawId;
                    fragmentTypes.set(rawId, isThink ? 'thinking' : 'text');
                } else if (currentFragmentId >= 0) {
                    fragmentTypes.set(currentFragmentId, isThink ? 'thinking' : 'text');
                }
                if (isThink && !thinkingFinished) {
                    currentType = 'thinking';
                } else {
                    thinkingFinished = true;
                    currentType = 'text';
                }
                return;
            }

            // 4. 路径 → 类型映射判断
            if (p === 'response/content' || p === 'content') {
                currentType = 'text';
            } else if (p === 'response/thinking_content' || p === 'thinking_content') {
                currentType = 'thinking';
            } else {
                const fm = p.match(/^response\/fragments\/(-?\d+)\/(thinking_content|content)$/);
                if (fm) {
                    const rawId = Number(fm[1]);
                    if (rawId >= 0) currentFragmentId = rawId;
                    const fid = rawId < 0 ? currentFragmentId : rawId;
                    if (fm[2] === 'thinking_content') {
                        currentType = 'thinking';
                    } else if (fm[2] === 'content') {
                        if (thinkingFinished) {
                            currentType = 'text';
                        } else {
                            const known = fragmentTypes.get(fid);
                            if (known) {
                                currentType = (known === 'thinking' && !thinkingFinished) ? 'thinking' : 'text';
                            } else {
                                currentType = (currentType === 'thinking' && !thinkingFinished) ? 'thinking' : 'text';
                            }
                        }
                    }
                } else if (p) {
                    // 未知或特定路径
                    const pathSaysThink = /thinking|think/i.test(p);
                    const pathSaysText = /(^|\/)(content|text)(_|$)/i.test(p) && !pathSaysThink;
                    if (typeof j.v === 'string') {
                        if (pathSaysThink && !thinkingFinished) { thinking += j.v; emit('thinking', j.v); return; }
                        else if (pathSaysText || thinkingFinished) { content += j.v; emit('content', j.v); return; }
                    }
                }
            }

            // 5. 处理常规文本增量 (如 {"v": "..."} 或 {"p":"response/fragments/-1/content", "v":"..."})
            let text = null;
            if (typeof j.v === 'string') text = j.v;
            if (text == null || text === '') return;
            if (text === 'FINISHED' && (p === 'status' || p === 'response/status')) {
                finished = true;
                return;
            }

            // 引用标记捕获
            if (/\[citation:\d+\]/.test(text)) citations.push(text);

            if (currentType === 'thinking' && !thinkingFinished) {
                thinking += text;
                emit('thinking', text);
            } else {
                content += text;
                emit('content', text);
            }
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

            handleParsed(j);
        };

        // 偏移扫描：每个 chunk 只做一次字符串压缩，消除逐行 slice 的 O(n²) 开销
        const drainBuf = () => {
            let start = 0;
            let idx;
            while ((idx = buf.indexOf('\n', start)) >= 0) {
                const line = buf.slice(start, idx).trim();
                start = idx + 1;
                if (line) handleLine(line);
            }
            if (start > 0) buf = start >= buf.length ? '' : buf.slice(start);
        };

        try {
            let finishedDraining = false;
            for (;;) {
                drainBuf();
                if (finished) {
                    // 状态已结束但可能还有残留内容帧在网络中，继续读取冲刷
                    if (finishedDraining) break;
                    finishedDraining = true;
                }

                let chunk;
                try {
                    chunk = await reader.read();
                } catch (e) {
                    abortedMidStream = true;
                    break;
                }
                if (chunk.done) break;
                if (!finished) resetStall();
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
        if (userAborted && !content && !thinking) {
            throw new DeepSeekApiError('客户端已中断请求', 499, null, TARGET_COMPLETION);
        }
        if (abortedMidStream && !content && !thinking) {
            throw new DeepSeekApiError('上游流式连接中断且无内容', 502, null, TARGET_COMPLETION);
        }
        // 空回复拦截：若最终既无正文又无思考内容，无论是否收到过元数据事件，均视为空响应异常，触发 Failover 重试
        if (!content && !thinking && !userAborted) {
            const hint = sawAnyEvent ? '收到事件但未解析到正文或思考内容' : '未收到任何 SSE 事件';
            logger.warn(`[SSE Empty] ${hint} finished=${finished} tokens=${tokens}`);
            throw new DeepSeekApiError(`上游返回空响应 (${hint})`, 502, null, TARGET_COMPLETION);
        }

        // 思考链与正文兜底分离：若思考字段为空且正文中包含 <think> 标签，自动剥离归位
        if (!thinking && content && content.includes('<think>')) {
            const m = content.match(/<think>([\s\S]*?)<\/think>/);
            if (m) {
                thinking = m[1].trim();
                content = content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
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
    dispatcherFor,
    resolveProxyUrl,
    withProxy,
};
