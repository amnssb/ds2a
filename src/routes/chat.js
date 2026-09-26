'use strict';
/**
 * src/routes/chat.js — OpenAI / Claude 兼容对话接口
 * - 自动从 AccountPool 获取健康账号，遇失效自动 Failover 故障转移
 * - 完整持久化至 storage，保证重启后数据不丢失
 * - 完整支持 SSE 流式、思考链 (thinking)、工具调用 (tools)、文件引用 (file_ids)
 * - 导出 sessions 供会话管理路由使用
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const storage = require('../storage');
const accountPool = require('../account-pool');
const ds = require('../ds-client');
const auth = require('../auth');
const upload = require('../upload');

const router = express.Router();

// ---------- 会话管理（DS parent_message_id 续接） ----------
const sessions = new Map(); // sessionKey -> { sid, parent, token, accName, lastUsed, ephemeral }
// 容量上限：客户端若用随机 x-session-id 刷接口，无上限 Map 会持续膨胀撑爆内存
const SESSIONS_MAX = Math.max(50, Number(process.env.DS_SESSIONS_MAX || 500));

/** 写入会话并按 LRU 淘汰最久未用的条目（Map 迭代序即插入序） */
function setSession(key, val) {
    if (sessions.has(key)) sessions.delete(key);
    sessions.set(key, val);
    while (sessions.size > SESSIONS_MAX) {
        const oldestKey = sessions.keys().next().value;
        const old = sessions.get(oldestKey);
        sessions.delete(oldestKey);
        if (old) ds.deleteSession(old.token, old.sid, old.proxy || '').catch(() => {});
    }
}

/** 命中即刷新 LRU 顺序 */
function touchSession(key) {
    const v = sessions.get(key);
    if (v) setSession(key, v);
}

        // 定期清理闲置会话
setInterval(async () => {
    const now = Date.now();
    for (const [k, v] of sessions.entries()) {
        if (now - v.lastUsed > config.SESSION_TTL_MS) {
            sessions.delete(k);
            await ds.deleteSession(v.token, v.sid, v.proxy || '').catch(() => {});
        }
    }
}, 15000);

function resolveSessionKey(req, body) {
    const h = req.headers['x-session-id'] || req.headers['x-conversation-id'];
    if (h) return { key: String(h).slice(0, 100), ephemeral: false };
    if (body && body.session_id) return { key: String(body.session_id).slice(0, 100), ephemeral: false };
    if (body && body.conversation_id) return { key: 'conv:' + String(body.conversation_id).slice(0, 90), ephemeral: false };
    return { key: '__eph_' + crypto.randomBytes(6).toString('hex'), ephemeral: true };
}

function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, other = 0;
    for (const ch of String(text)) {
        if (/[㐀-鿿぀-ヿ가-힯]/.test(ch)) cjk++; else other++;
    }
    return Math.ceil(cjk + other / 4);
}

/** 估算入站请求的 prompt token（供 Claude message_start 提前回传） */
function estimateRequestInputTokens(body) {
    if (!body) return 0;
    let n = estimateTokens(contentToText(body.system || ''));
    const msgs = body.messages || [];
    if (Array.isArray(msgs)) {
        for (const m of msgs) n += estimateTokens(contentToText(m && m.content));
    }
    return n;
}

/**
 * 统一用量计算：
 * - promptTokens: 基于输入请求体（body.messages / system / prompt）准确计算或估算，不人为捏造
 * - tTokens: 思考链 token 估算值
 * - cTokens: 模型正文 token 消耗。上游 accumulated_token_usage (r.tokens) 为输出总量（thinking+content），
 *   扣除 tTokens 即为真实的 completion token；若无上游数值则基于正文估算
 * - totalTokens: prompt + completion + thinking
 */
function computeUsage(r, body, fallbackContent, fallbackThinking) {
    const pTokens = Math.max(1, estimateRequestInputTokens(body) || estimateTokens(r.prompt || ''));
    const tTokens = estimateTokens(fallbackThinking || r.thinking || '');
    let cTokens = 0;
    if (r.tokens && r.tokens > 0) {
        const totalOut = Math.max(0, Math.round(r.tokens));
        cTokens = Math.max(0, totalOut - tTokens);
        if (cTokens === 0 && (r.content || fallbackContent)) {
            cTokens = estimateTokens(r.content || fallbackContent);
        }
    } else {
        cTokens = estimateTokens(r.content || fallbackContent || '');
    }
    const totalTokens = pTokens + cTokens + tTokens;
    return { pTokens, cTokens, tTokens, totalTokens };
}

function contentToText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c.map(x => {
            if (typeof x === 'string') return x;
            if (!x) return '';
            if (x.type === 'text') return x.text || '';
            if (x.type === 'image_url' || x.type === 'image') return '[Image]';
            if (x.type === 'file' || x.type === 'input_file') return '[File]';
            if (x.type === 'tool_use') return '[Tool Call] ' + (x.name || '') + ' ' + JSON.stringify(x.input || {});
            if (x.type === 'tool_result') return '[Tool Result] ' + contentToText(x.content);
            return x.text || '';
        }).filter(Boolean).join('\n');
    }
    if (c == null) return '';
    return JSON.stringify(c);
}

function buildPrompt(messages, system, isNewSession) {
    if (!Array.isArray(messages)) return { prompt: String(messages || ''), flat: false };

    const sys = [];
    if (system) sys.push(contentToText(system));
    for (const m of messages) if (m && (m.role === 'system' || m.role === 'developer')) sys.push(contentToText(m.content));

    if (!isNewSession) {
        const lastIdx = [...messages].reduce((fi, m, i) => (m && (m.role === 'user' || m.role === 'tool')) ? i : fi, -1);
        if (lastIdx < 0) return { prompt: JSON.stringify(messages), flat: false };
        const last = messages[lastIdx];
        let body = contentToText(last.content);
        for (let i = lastIdx - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
                body = m.tool_calls.map(tc => '[Tool Call] ' + ((tc.function || {}).name || '') + ' ' + ((tc.function || {}).arguments || '{}')).join('\n') + '\n' + body;
                break;
            }
            if (m && m.role === 'user') break;
        }
        return { prompt: sys.length ? ('[System]\n' + sys.join('\n\n') + '\n\n[User]\n' + body) : body, flat: false };
    }

    const parts = [];
    if (sys.length) parts.push('[System]\n' + sys.join('\n\n'));
    for (const m of messages) {
        if (!m || !m.role) continue;
        if (m.role === 'system' || m.role === 'developer') continue;
        const role = m.role === 'assistant' ? 'Assistant' : (m.role === 'user' ? 'User' : (m.role === 'tool' ? 'Tool' : String(m.role)));
        let text = contentToText(m.content);
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
            text += (text ? '\n' : '') + m.tool_calls.map(tc => '[Tool Call] ' + ((tc.function || {}).name || '') + ' ' + ((tc.function || {}).arguments || '{}')).join('\n');
        }
        if (!text) continue;
        parts.push('[' + role + ']\n' + text);
    }
    return { prompt: parts.join('\n\n'), flat: true };
}

function extractInlineFiles(messages) {
    const out = [];
    if (!Array.isArray(messages)) return out;
    for (const m of messages) {
        if (!m || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
            if (!b || typeof b !== 'object') continue;
            if (b.type === 'image_url' && b.image_url && b.image_url.url) {
                const u = b.image_url.url;
                const mm = /^data:([^;]+);base64,(.+)$/.exec(u);
                if (mm) out.push({ name: 'image.' + (mm[1].split('/')[1] || 'png'), mime: mm[1], data: Buffer.from(mm[2], 'base64') });
            } else if ((b.type === 'file' || b.type === 'input_file') && b.file_data) {
                const fd = b.file_data;
                const mm = /^data:([^;]+);base64,(.+)$/.exec(fd);
                if (mm) out.push({ name: b.filename || 'file.bin', mime: mm[1], data: Buffer.from(mm[2], 'base64') });
            }
        }
    }
    return out;
}

function resolveThinking(body) {
    if (!body) return false;
    if (typeof body.thinking === 'boolean') return body.thinking;
    if (typeof body.enable_thinking === 'boolean') return body.enable_thinking;
    if (body.thinking && typeof body.thinking === 'object' && typeof body.thinking.enabled === 'boolean') return body.thinking.enabled;
    const eff = body.reasoning_effort;
    if (typeof eff === 'string') return !(eff === 'none' || eff === 'off');
    const m = String(body.model || '').toLowerCase();
    if (/-think(ing)?$/.test(m) || /reasoner|deepseek-r1|r1/.test(m)) return true;
    return false;
}

function resolveSearch(body) {
    if (!body) return true;
    if (typeof body.search === 'boolean') return body.search;
    if (typeof body.enable_search === 'boolean') return body.enable_search;
    if (typeof body.web_search === 'boolean') return body.web_search;
    if (body.web_search_options) return true;
    if (Array.isArray(body.tools)) {
        for (const t of body.tools) {
            const ty = String((t && t.type) || '').toLowerCase();
            if (/web_search|search/.test(ty)) return true;
        }
    }
    return true;
}

// ---------- 工具调用协议 (<<<TOOL_CALL>>> 协议 + 裸JSON/<<>>高容错提取与流式分流) ----------
const TC_START = '<<<TOOL_CALL>>>';
const TC_END = '<<<END_TOOL_CALL>>>';

function normalizeTool(t) {
    if (!t) return null;
    const f = t.function || t;
    if (!f || !f.name) return null;
    return { name: String(f.name), description: f.description ? String(f.description) : '', schema: f.parameters || f.input_schema || {} };
}

function injectTools(prompt, tools) {
    if (!Array.isArray(tools) || !tools.length) return prompt;
    const defs = tools.map(t => {
        const n = normalizeTool(t);
        return n ? ('- ' + n.name + (n.description ? ': ' + n.description : '') + '\n  Parameters: ' + JSON.stringify(n.schema)) : null;
    }).filter(Boolean).join('\n');
    if (!defs) return prompt;
    return prompt + '\n\n[Available Tools]\n' + defs + '\n\n当需要调用工具时，请在回复末尾严格按以下格式输出（可多个）：\n' + TC_START + '\n{"name": "工具名", "arguments": { ...JSON参数... }}\n' + TC_END + '\n工具调用必须放在回复最后，arguments 必须是合法 JSON。';
}

function extractArguments(obj) {
    if (obj.arguments !== undefined) {
        return typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments || {});
    }
    if (obj.parameters !== undefined) {
        return typeof obj.parameters === 'string' ? obj.parameters : JSON.stringify(obj.parameters || {});
    }
    const args = Object.assign({}, obj);
    delete args.name;
    delete args.type;
    delete args.id;
    return JSON.stringify(args);
}

function parseToolCalls(text) {
    if (!text) return { content: '', toolCalls: [] };
    const calls = [];
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let clean = text;

    // 1. 标准 <<<TOOL_CALL>>> ... <<<END_TOOL_CALL>>>
    if (clean.includes(TC_START)) {
        const re = new RegExp(esc(TC_START) + '([\\s\\S]*?)' + esc(TC_END), 'g');
        clean = clean.replace(re, (_, inner) => {
            try {
                const j = JSON.parse(inner.trim());
                for (const it of (Array.isArray(j) ? j : [j])) {
                    if (!it || !it.name) continue;
                    calls.push({
                        id: 'call_' + crypto.randomBytes(6).toString('hex'),
                        type: 'function',
                        function: {
                            name: String(it.name),
                            arguments: extractArguments(it),
                        },
                    });
                }
            } catch (e) {}
            return '';
        });
    }

    // 2. 兼容处理 <<>> 分隔的裸 JSON 工具调用序列 (例如 OpenCode / DeepSeek 偶发裸输出)
    if (clean.includes('<<>>')) {
        const chunks = clean.split('<<>>');
        const surviving = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i].trim();
            if (!chunk) continue;
            const jsonMatch = chunk.match(/\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const j = JSON.parse(jsonMatch[0]);
                    if (j && j.name) {
                        calls.push({
                            id: 'call_' + crypto.randomBytes(6).toString('hex'),
                            type: 'function',
                            function: {
                                name: String(j.name),
                                arguments: extractArguments(j),
                            },
                        });
                        const before = chunk.slice(0, jsonMatch.index).trim();
                        if (before) surviving.push(before);
                        continue;
                    }
                } catch (e) {}
            }
            surviving.push(chunk);
        }
        clean = surviving.join('\n\n').trim();
    }

    // 3. 兼容末尾出现的单独裸 JSON 工具调用 (无 <<<TOOL_CALL>>> 包装)
    const reStandaloneJson = /\n*\s*\{[\s\n\r]*"name"\s*:\s*"([^"]+)"[\s\S]*\}\s*$/;
    const standaloneMatch = clean.match(reStandaloneJson);
    if (standaloneMatch) {
        try {
            const j = JSON.parse(standaloneMatch[0].trim());
            if (j && j.name) {
                calls.push({
                    id: 'call_' + crypto.randomBytes(6).toString('hex'),
                    type: 'function',
                    function: {
                        name: String(j.name),
                        arguments: extractArguments(j),
                    },
                });
                clean = clean.slice(0, standaloneMatch.index).trim();
            }
        } catch (e) {}
    }

    // 4. 清理残留元标记与多余空行
    clean = clean
        .replace(/<[｜\|]?DSML[｜\|][\s\S]*?>/gi, '')
        .replace(/<\/?[a-zA-Z0-9_-]*tool_calls?>/gi, '')
        .replace(/\[citation:\d+\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { content: clean, toolCalls: calls };
}

/** 工具参数宽容解析：模型可能输出非法 JSON，解析失败时保留原始串，避免整个请求 500 */
function safeParseToolArgs(raw) {
    const s = raw || '{}';
    try { return JSON.parse(s); } catch (e) { return { _raw: String(s) }; }
}

/** 流式筛分器：实时拦截 <think> 思考链并分流至 onThinking，阻断工具调用字符泄露至正文 */
function createToolCallFilter(hasTools, emit, onThinking) {
    let buf = '';
    let inThink = false;
    let inTool = false;

    const THINK_START = '<think>';
    const THINK_END = '</think>';

    function feed(delta) {
        if (!delta) return;
        buf += delta;

        while (buf.length > 0) {
            // 1. 处于思考标签内部：将内容实时分流至 onThinking，绝不漏进正文
            if (inThink) {
                const endIdx = buf.indexOf(THINK_END);
                if (endIdx >= 0) {
                    const thinkChunk = buf.slice(0, endIdx);
                    if (thinkChunk && onThinking) onThinking(thinkChunk);
                    buf = buf.slice(endIdx + THINK_END.length);
                    inThink = false;
                    continue;
                }
                // 检查是否有 partial THINK_END 截断在末尾
                let hold = 0;
                for (let k = Math.min(buf.length, THINK_END.length - 1); k > 0; k--) {
                    if (THINK_END.startsWith(buf.slice(-k))) { hold = k; break; }
                }
                const toEmit = buf.slice(0, buf.length - hold);
                if (toEmit && onThinking) onThinking(toEmit);
                buf = buf.slice(buf.length - hold);
                return;
            }

            // 2. 处于工具调用块内部：静默缓冲，绝不外发给客户端正文
            if (inTool) {
                const endIdx = buf.indexOf(TC_END);
                if (endIdx >= 0) {
                    buf = buf.slice(endIdx + TC_END.length);
                    inTool = false;
                    continue;
                }
                return;
            }

            // 3. 检查是否进入 <think>
            const thinkIdx = buf.indexOf(THINK_START);
            if (thinkIdx >= 0) {
                if (thinkIdx > 0 && emit) emit(buf.slice(0, thinkIdx));
                buf = buf.slice(thinkIdx + THINK_START.length);
                inThink = true;
                continue;
            }

            // 4. 若启用了工具，检查是否进入工具标记
            if (hasTools) {
                const tcIdx = buf.indexOf(TC_START);
                if (tcIdx >= 0) {
                    if (tcIdx > 0 && emit) emit(buf.slice(0, tcIdx));
                    buf = buf.slice(tcIdx + TC_START.length);
                    inTool = true;
                    continue;
                }

                // 检查裸 JSON 工具调用: \n{"name": 或 {"name":
                const rawJsonMatch = buf.match(/(?:^|\n)\s*\{\s*"name"\s*:\s*"/);
                if (rawJsonMatch) {
                    const idx = rawJsonMatch.index;
                    if (idx > 0 && emit) emit(buf.slice(0, idx));
                    buf = buf.slice(idx);
                    inTool = true;
                    return;
                }
            }

            // 5. 检查边缘 partial 截断（防止标签被分片打断泄露）
            let hold = 0;
            const candidates = [THINK_START];
            if (hasTools) candidates.push(TC_START, '<|DSML|', '<tool_calls>', '<tool_call>');
            for (const cand of candidates) {
                for (let k = Math.min(buf.length, cand.length - 1); k > 0; k--) {
                    if (cand.startsWith(buf.slice(-k))) {
                        hold = Math.max(hold, k);
                    }
                }
            }

            if (hasTools) {
                const jsonPrefixes = ['\n', '\n{', '\n{"', '\n{"name', '\n{"name"', '\n{"name":'];
                for (const p of jsonPrefixes) {
                    if (buf.endsWith(p)) {
                        hold = Math.max(hold, p.length);
                    }
                }
            }

            if (hold > 0) {
                const safe = buf.slice(0, buf.length - hold);
                if (safe && emit) emit(safe);
                buf = buf.slice(buf.length - hold);
                return;
            }

            if (emit) emit(buf);
            buf = '';
            return;
        }
    }

    function flush() {
        if (buf && !inThink && !inTool) {
            if (emit) emit(buf);
        }
        buf = '';
    }

    return { push: feed, flush };
}

function resolveApiKey(req) {
    const raw = req.headers.authorization || req.headers['x-api-key'];
    const info = auth.verifyApiKey(raw);
    if (info) return info;
    if (config.REQUIRE_KEY) return null;
    return { keyId: null, name: '(匿名)' };
}

// ---------- 用量入账（OpenAI / Claude 两端点共用） ----------
function accountingSuccess(r, { endpoint, id, t0, model, stream, keyInfo, sess, usage }) {
    const { pTokens, cTokens, tTokens } = usage;
    try {
        storage.record({
            id,
            at: t0,
            endpoint,
            model: model || 'deepseek-v4.1-flash',
            ok: true,
            status: 200,
            ms: Date.now() - t0,
            stream,
            tools: r.hasTools,
            thinking: r.thinkingEnabled,
            search: r.search,
            account: r.accountName,
            keyName: keyInfo.name,
            session: sess.ephemeral ? '(一次性)' : sess.key,
            ephemeral: sess.ephemeral,
            promptTokens: pTokens,
            completionTokens: cTokens,
            thinkingTokens: tTokens,
        });
        auth.recordUsage({
            keyId: keyInfo.keyId,
            account: r.accountName,
            ok: true,
            promptTokens: pTokens,
            completionTokens: cTokens,
            thinkingTokens: tTokens,
        });
    } catch (recErr) {
        logger.err(endpoint + ' 记录用量失败: ' + recErr.message);
    }
}

function accountingFailure({ endpoint, id, t0, model, stream, keyInfo, status, error, account }) {
    try {
        storage.record({
            id,
            at: t0,
            endpoint,
            model: model || 'deepseek-v4.1-flash',
            ok: false,
            status,
            ms: Date.now() - t0,
            stream,
            error,
            account: account || 'unknown',
            keyName: keyInfo.name,
        });
        auth.recordUsage({
            keyId: keyInfo.keyId,
            account: account || 'failed',
            ok: false,
        });
    } catch (recErr) {}
}

// ---------- 核心执行逻辑（多账号 Failover 故障转移） ----------
async function executeWithFailover(opts) {
    const { body, sessionKey, ephemeral, signal, onThinking, onDelta, stream } = opts;
    const thinking = resolveThinking(body);
    const search = resolveSearch(body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const inlineFiles = extractInlineFiles(body.messages || []);

    // 检查是否有上传文件引用
    const wantedFiles = [].concat(body.file_ids || [], body.files || []).filter(x => typeof x === 'string');
    for (const fid of wantedFiles) {
        const f = upload.uploadBuffers.get(fid);
        if (f) {
            inlineFiles.push({ name: f.name, mime: f.mime, data: Buffer.from(f.data, 'base64') });
        }
    }

    const excludedAccounts = [];
    const transientRetried = new Set();
    const triedAccounts = [];
    let lastAccountName = null;
    let lastError = null;
    // 流式模式下只要已向客户端吐出过任何增量，就绝不能再换账号重试，
    // 否则第二次完整回复会拼接在第一次的残句之后，造成内容重复错乱
    let emittedOnce = false;

    // 流式累计（execute 内闭包，供空回复校验）
    let _streamContent = '';
    let _streamThinking = '';
    const contentSnapshot = () => _streamContent;
    const thinkingSnapshot = () => _streamThinking;

    const maxTries = Math.min(Math.max(1, accountPool.accounts.length), 5);
    // 瞬时故障多给一次重试机会（即使只有 1 个账号）
    const maxAttempts = Math.min(Math.max(2, maxTries + 1), 6);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        _streamContent = '';
        _streamThinking = '';
        // 若所有账号都已在前面尝试过，无需再次进入 acquire，直接结束以防死循环
        if (excludedAccounts.length >= accountPool.accounts.length) {
            break;
        }

        // 会话粘滞账号：已有会话时优先复用原账号（sid/token 必须同账号）
        const prevSess = sessions.get(sessionKey);
        if (prevSess) touchSession(sessionKey);
        const preferName = prevSess && prevSess.accName ? prevSess.accName : null;

        let account = null;
        try {
            account = accountPool.acquire(excludedAccounts, preferName);
            lastAccountName = account.name;
            if (!triedAccounts.includes(account.name)) triedAccounts.push(account.name);
        } catch (e) {
            const errToThrow = lastError || e;
            if (!errToThrow.accountName) {
                errToThrow.accountName = e.accountName || lastAccountName || (triedAccounts.length ? triedAccounts.join('->') : (preferName || 'unknown'));
            } else if (triedAccounts.length > 1) {
                errToThrow.accountName = triedAccounts.join('->');
            }
            errToThrow.triedAccounts = triedAccounts;
            throw errToThrow;
        }

        try {
            let sess = prevSess;
            let isNew = !sess;

            // 会话账号不一致（prefer 失败/账号被熔断换人）：丢弃旧会话重建
            if (sess && sess.accName !== account.name) {
                sessions.delete(sessionKey);
                const old = sess;
                const oldProxy = old.proxy || '';
                ds.deleteSession(old.token, old.sid, oldProxy).catch(() => {});
                sess = null;
                isNew = true;
            }

            const accProxy = account.proxy || '';

            // 1. 会话建立
            if (!sess) {
                const sid = await ds.createSession(account.token, accProxy);
                sess = {
                    sid,
                    parent: null,
                    token: account.token,
                    accName: account.name,
                    proxy: accProxy,
                    lastUsed: Date.now(),
                    ephemeral: !!ephemeral,
                };
                setSession(sessionKey, sess);
                logger.info(`新建会话 ${sessionKey} → 账号: ${account.name} | sid: ${sid.slice(0, 8)}`);
            }
            sess.lastUsed = Date.now();

            // 2. 附件上传
            const uploadedFileIds = [];
            if (inlineFiles.length) {
                for (const f of inlineFiles) {
                    const fid = await ds.uploadFile(account.token, f.name, f.data, f.mime, 'default', accProxy);
                    await ds.waitFileReady(account.token, fid, 60000, accProxy);
                    uploadedFileIds.push(fid);
                    logger.info(`附件已成功挂载至 DeepSeek: ${f.name} → ${fid.slice(0, 16)}`);
                }
            }

            // 3. 构造 Prompt
            const { prompt } = buildPrompt(body.messages || [], body.system, isNew);
            const finalPrompt = hasTools ? injectTools(prompt, body.tools) : prompt;

            // 4. 对话调用
            const r = await ds.completion({
                token: account.token,
                sessionId: sess.sid,
                prompt: finalPrompt,
                parentMessageId: sess.parent,
                thinkingEnabled: thinking,
                searchEnabled: search,
                refFileIds: uploadedFileIds,
                onEvent: (ty, d) => {
                    if (stream) emittedOnce = true;
                    if (ty === 'thinking') {
                        _streamThinking += d;
                        onThinking(d);
                    } else if (ty === 'content') {
                        _streamContent += d;
                        onDelta(d);
                    }
                },
                signal,
                proxy: accProxy,
            });

            // 空回复双重防线：若最终既无正文又无思考内容，视为上游空响应抛错，触发重试/Failover
            const streamedContent = contentSnapshot();
            const streamedThinking = thinkingSnapshot();
            const finalContent = r.content || streamedContent;
            const finalThinking = r.thinking || streamedThinking;

            if (!finalContent && !finalThinking) {
                const clientCancel = signal && signal.aborted;
                if (!clientCancel) {
                    throw Object.assign(new Error('上游返回空响应 (无正文且无思考内容)'), { statusCode: 502 });
                }
            }

            if (r.messageId) sess.parent = r.messageId;
            accountPool.markOk(account);

            // 一次性会话清理
            if (sess.ephemeral) {
                sessions.delete(sessionKey);
                ds.deleteSession(account.token, sess.sid, accProxy).catch(() => {});
            }

            return {
                ...r,
                content: r.content || streamedContent,
                thinking: r.thinking || streamedThinking,
                accountName: account.name,
                thinkingEnabled: thinking,
                search,
                hasTools,
                prompt: finalPrompt,
            };
        } catch (err) {
            lastError = err;
            if (account && !lastError.accountName) {
                lastError.accountName = account.name;
            }
            // 发生空响应或断流时，立即清理会话上下文缓存，防止残留的 parent_message_id 导致后续请求持续空回
            if (/空响应|未收到任何 SSE 事件|连接中断/i.test(err.message || '')) {
                sessions.delete(sessionKey);
            }
            const bizCode = err.bizCode || (err.message && err.message.match(/code=(\d+)/) ? Number(err.message.match(/code=(\d+)/)[1]) : null);
            // 客户端主动取消不惩罚账号
            const clientCancel = err && (err.statusCode === 499 || /客户端已中断/i.test(err.message || ''));
            const isPowError = bizCode === 40301 || /INVALID_POW_RESPONSE/i.test(err.message || '');
            if (!clientCancel && !isPowError) {
                accountPool.markFail(account, err, err.statusCode || 500, bizCode);
            }
            // 流式已出口：重试必然造成重复拼接，直接把错误抛给端点收尾，不再 Failover
            if (stream && emittedOnce) {
                if (account && !err.accountName) err.accountName = account.name;
                err.triedAccounts = triedAccounts;
                throw err;
            }
            // 瞬时网络/空响应/PoW凭证抖动：不立刻排除账号，允许同一请求内快速重试一次
            const transient = !clientCancel && (
                err.statusCode === 502 || err.statusCode === 504 || isPowError ||
                /上游网络异常|空响应|连接中断|停滞超时|fetch failed/i.test(err.message || '')
            );
            if (!transient) {
                excludedAccounts.push(account.name);
            } else if (!transientRetried.has(account.name)) {
                // 瞬时故障仅允许同一请求内重试一次，不立刻排除
                transientRetried.add(account.name);
                logger.warn(`账号 ${account.name} 瞬时故障，立即重试一次: ${err.message}`);
            } else {
                excludedAccounts.push(account.name);
            }
            logger.warn(`账号 ${account.name} 调用异常，正在尝试故障转移... (已排除: ${excludedAccounts.join(', ')})`);
        } finally {
            if (account) accountPool.release(account);
        }
    }

    const finalErr = lastError || new Error('所有可用账号均尝试失败喵');
    if (!finalErr.accountName) {
        finalErr.accountName = lastAccountName || (triedAccounts.length ? triedAccounts.join('->') : 'unknown');
    } else if (triedAccounts.length > 1) {
        finalErr.accountName = triedAccounts.join('->');
    }
    finalErr.triedAccounts = triedAccounts;
    throw finalErr;
}

// ===== OpenAI 兼容端点 =====
function oaiChunk(id, delta, model) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'deepseek-v4.1-flash',
        choices: [{ index: 0, delta, finish_reason: null }],
    };
}
function oaiFinish(id, reason, model) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'deepseek-v4.1-flash',
        choices: [{ index: 0, delta: {}, finish_reason: reason || 'stop' }],
    };
}

router.post('/v1/chat/completions', async (req, res) => {
    if (req.socket) req.socket.setTimeout(0);
    const t0 = Date.now();
    const id = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
    const body = req.body || {};
    const stream = !!body.stream;
    const keyInfo = resolveApiKey(req);

    if (!keyInfo) {
        return res.status(401).json({ error: { message: 'API key 无效或缺失喵', type: 'invalid_request_error' } });
    }

    const sess = resolveSessionKey(req, body);

    const ensureStreamHeaders = () => {
        if (stream && !res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (res.flushHeaders) res.flushHeaders();
        }
    };

    let content = '', thinking = '';
    const ac = new AbortController();
    // 仅在响应未完整写出时视为客户端断开；req.close 在 body 读完后也会触发，不能用
    res.on('close', () => {
        if (!res.writableEnded) ac.abort();
    });

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    let oaiRoleSent = false;
    const filter = createToolCallFilter(hasTools, (d) => {
        content += d;
        if (stream) {
            ensureStreamHeaders();
            if (!oaiRoleSent) {
                res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant', content: d }, body.model)) + '\n\n');
                oaiRoleSent = true;
            } else {
                res.write('data: ' + JSON.stringify(oaiChunk(id, { content: d }, body.model)) + '\n\n');
            }
        }
    }, (thinkDelta) => {
        thinking += thinkDelta;
        if (stream) {
            ensureStreamHeaders();
            if (!oaiRoleSent) {
                res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant' }, body.model)) + '\n\n');
                oaiRoleSent = true;
            }
            res.write('data: ' + JSON.stringify(oaiChunk(id, { reasoning_content: thinkDelta }, body.model)) + '\n\n');
        }
    });

    try {
        const r = await executeWithFailover({
            body,
            sessionKey: sess.key,
            ephemeral: sess.ephemeral,
            signal: ac.signal,
            onThinking: d => {
                thinking += d;
                if (stream) {
                    ensureStreamHeaders();
                    if (!oaiRoleSent) {
                        res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant' }, body.model)) + '\n\n');
                        oaiRoleSent = true;
                    }
                    res.write('data: ' + JSON.stringify(oaiChunk(id, { reasoning_content: d }, body.model)) + '\n\n');
                }
            },
            onDelta: d => filter.push(d),
        });
        filter.flush();

        if (stream && !oaiRoleSent) {
            ensureStreamHeaders();
            res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant' }, body.model)) + '\n\n');
            oaiRoleSent = true;
        }

        const rawContent = r.content || content;
        const parsed = (r.hasTools || hasTools) ? parseToolCalls(rawContent, body.tools) : { content: rawContent, toolCalls: [] };
        const finish = parsed.toolCalls.length ? 'tool_calls' : (r.finishReason === 'length' ? 'length' : 'stop');

        const { pTokens, cTokens, tTokens, totalTokens } = computeUsage(r, body, rawContent, thinking);

        // 记录用量与请求日志（失败不影响已开流的收尾帧）
        accountingSuccess(r, {
            endpoint: '/v1/chat/completions',
            id,
            t0,
            model: body.model,
            stream,
            keyInfo,
            sess,
            usage: { pTokens, cTokens, tTokens },
        });

        // OpenAI 官方语义：completion 含 reasoning，total = prompt + completion
        const clientUsage = {
            prompt_tokens: pTokens,
            completion_tokens: cTokens + tTokens,
            total_tokens: totalTokens,
            completion_tokens_details: { reasoning_tokens: tTokens },
        };

        if (stream) {
            // 若流式输出中从未输出过任何帧（无 role 无 thinking 无 content），补发空 role 帧以保证协议合法
            if (!content && !oaiRoleSent && !parsed.toolCalls.length) {
                ensureStreamHeaders();
                res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant', content: '' }, body.model)) + '\n\n');
                oaiRoleSent = true;
            }

            for (let i = 0; i < parsed.toolCalls.length; i++) {
                const tc = parsed.toolCalls[i];
                res.write('data: ' + JSON.stringify(oaiChunk(id, { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, body.model)) + '\n\n');
            }
            // 必须先发带合法 finish_reason 的终止块，否则 AI SDK 等客户端会报 finish reason "other"
            res.write('data: ' + JSON.stringify(oaiFinish(id, finish, body.model)) + '\n\n');
            // 仅在客户端声明 stream_options.include_usage 时回传空 choices + usage（与 OpenAI 一致，避免严格客户端被空 choices 扰乱）
            const wantUsage = !!(body.stream_options && body.stream_options.include_usage);
            if (wantUsage) {
                res.write('data: ' + JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || 'deepseek-v4.1-flash',
                    choices: [],
                    usage: clientUsage,
                }) + '\n\n');
            }
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            let finalContent = parsed.toolCalls.length ? (parsed.content || null) : (parsed.content || '');
            const msg = { role: 'assistant', content: finalContent };
            if (r.thinking || thinking) msg.reasoning_content = r.thinking || thinking;
            if (parsed.toolCalls.length) msg.tool_calls = parsed.toolCalls;

            res.json({
                id,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: body.model || 'deepseek-v4.1-flash',
                choices: [{ index: 0, message: msg, finish_reason: finish }],
                usage: clientUsage,
            });
        }

        logger.ok(`完成请求 ${Date.now() - t0}ms | 正文:${rawContent.length}字 思考:${(r.thinking || thinking).length}字 | 账号: ${r.accountName}`);
    } catch (e) {
        logger.err('chat/completions 失败: ' + e.message);

        const status = (e.statusCode && e.statusCode >= 400 && e.statusCode < 600 && e.statusCode !== 499) ? e.statusCode : 500;
        const failAcc = e.accountName || (e.triedAccounts && e.triedAccounts.length ? e.triedAccounts.join('->') : 'unknown');
        // 统计入账失败不阻断错误响应
        accountingFailure({
            endpoint: '/v1/chat/completions',
            id,
            t0,
            model: body.model,
            stream,
            keyInfo,
            status,
            error: e.message,
            account: failAcc,
        });

        if (!res.headersSent) {
            res.status(status).json({
                error: {
                    message: e.message,
                    type: 'api_error',
                    code: status,
                }
            });
        } else {
            // 流已开（在吐字中间发生断流）：向客户端发送标准错误数据帧并优雅关闭，绝不将错误伪造成 assistant 正常回复
            try {
                if (!res.writableEnded) {
                    res.write('data: ' + JSON.stringify({ error: { message: e.message, type: 'stream_error', code: status } }) + '\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            } catch (e2) {}
        }
    }
});

// ===== Claude 兼容端点 (/v1/messages) =====
router.post('/v1/messages', async (req, res) => {
    if (req.socket) req.socket.setTimeout(0);
    const t0 = Date.now();
    const id = 'msg_' + crypto.randomBytes(12).toString('hex');
    const body = req.body || {};
    const stream = !!body.stream;
    const keyInfo = resolveApiKey(req);

    if (!keyInfo) {
        return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'API key 无效或缺失喵' } });
    }

    const sess = resolveSessionKey(req, body);

    const ensureStreamStarted = () => {
        if (stream && !res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (res.flushHeaders) res.flushHeaders();
            // 先按请求内容估算 input_tokens，避免 message_start 恒为 0 导致客户端无法统计入站用量喵
            const estInput = estimateRequestInputTokens(body);
            res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model || 'deepseek-v4.1-flash', content: [], stop_reason: null, usage: { input_tokens: estInput, output_tokens: 0 } } }) + '\n\n');
        }
    };

    let content = '', thinking = '';
    const ac = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) ac.abort();
    });

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const filter = createToolCallFilter(hasTools, (d) => {
        content += d;
        if (stream) {
            res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: textBlockIndex(), delta: { type: 'text_delta', text: d } }) + '\n\n');
        }
    }, (thinkDelta) => {
        thinking += thinkDelta;
        if (stream) {
            const idx = ensureThinkBlock();
            res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinkDelta } }) + '\n\n');
        }
    });

    // Claude content block 状态机：thinking 必须在 text 之前，块序号严格递增
    let thinkBlockIdx = -1;
    let thinkStopped = false;
    let textIdx = -1;
    let nextIdx = 0;

    const stopThinkBlock = () => {
        if (thinkBlockIdx < 0 || thinkStopped) return;
        thinkStopped = true;
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: thinkBlockIdx, delta: { type: 'signature_delta', signature: 'sig_' + id.slice(-8) } }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: thinkBlockIdx }) + '\n\n');
    };

    const textBlockIndex = () => {
        if (textIdx >= 0) return textIdx;
        ensureStreamStarted();
        stopThinkBlock();
        textIdx = nextIdx++;
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } }) + '\n\n');
        return textIdx;
    };

    const ensureThinkBlock = () => {
        if (thinkBlockIdx >= 0) return thinkBlockIdx;
        ensureStreamStarted();
        thinkBlockIdx = nextIdx++;
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: thinkBlockIdx, content_block: { type: 'thinking', thinking: '', signature: '' } }) + '\n\n');
        return thinkBlockIdx;
    };

    try {
        const r = await executeWithFailover({
            body,
            sessionKey: sess.key,
            ephemeral: sess.ephemeral,
            signal: ac.signal,
            onThinking: d => {
                thinking += d;
                if (stream) {
                    const idx = ensureThinkBlock();
                    res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: d } }) + '\n\n');
                }
            },
            onDelta: d => filter.push(d),
        });
        filter.flush();
        if (stream && !res.headersSent) {
            ensureStreamStarted();
        }

        const rawContent = r.content || content;
        const parsed = (r.hasTools || hasTools) ? parseToolCalls(rawContent, body.tools) : { content: rawContent, toolCalls: [] };
        const finish = parsed.toolCalls.length ? 'tool_use' : (r.finishReason === 'length' ? 'max_tokens' : 'end_turn');

        // 保证在有需要时补齐 text 块（客户端期待固定块序），但绝不把 thinking 重复复制为 text_delta 泄露到正文
        if (stream && textIdx < 0 && !parsed.toolCalls.length) {
            textBlockIndex();
        }

        const { pTokens, cTokens, tTokens, totalTokens } = computeUsage(r, body, rawContent, thinking);
        const outTokens = cTokens + tTokens;

        accountingSuccess(r, {
            endpoint: '/v1/messages',
            id,
            t0,
            model: body.model,
            stream,
            keyInfo,
            sess,
            usage: { pTokens, cTokens, tTokens },
        });

        if (stream) {
            // 收尾：先 stop 仍在打开的 text，再 stop 尚未关闭的 thinking
            if (textIdx >= 0) {
                res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: textIdx }) + '\n\n');
            }
            stopThinkBlock();
            for (const tc of parsed.toolCalls) {
                const bIdx = nextIdx++;
                res.write('event: content_block_start\ndata: ' + JSON.stringify({
                    type: 'content_block_start',
                    index: bIdx,
                    content_block: {
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input: {}
                    }
                }) + '\n\n');
                const rawArgs = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {});
                res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                    type: 'content_block_delta',
                    index: bIdx,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: rawArgs
                    }
                }) + '\n\n');
                res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: bIdx }) + '\n\n');
            }
            res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: finish }, usage: { output_tokens: outTokens } }) + '\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
        } else {
            // 非流式：thinking 必须在 text 之前，thinking 块需带 signature
            const blocks = [];
            if (r.thinking || thinking) {
                blocks.push({ type: 'thinking', thinking: r.thinking || thinking, signature: 'sig_' + id.slice(-8) });
            }
            const effectiveText = rawContent || '';
            if (effectiveText || !blocks.length) blocks.push({ type: 'text', text: effectiveText });
            for (const tc of parsed.toolCalls) {
                blocks.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: safeParseToolArgs(tc.function.arguments),
                });
            }

            res.json({
                id,
                type: 'message',
                role: 'assistant',
                model: body.model || 'deepseek-v4.1-flash',
                content: blocks,
                stop_reason: finish,
                usage: { input_tokens: pTokens, output_tokens: outTokens },
            });
        }
    } catch (e) {
        logger.err('v1/messages 失败: ' + e.message);

        const status = (e.statusCode && e.statusCode >= 400 && e.statusCode < 600 && e.statusCode !== 499) ? e.statusCode : 500;
        const failAcc = e.accountName || (e.triedAccounts && e.triedAccounts.length ? e.triedAccounts.join('->') : 'unknown');
        // 与 OpenAI 端点对齐：失败请求同样入账，避免 Claude 失败调用在统计中完全丢失喵
        // 统计入账失败不阻断收尾
        accountingFailure({
            endpoint: '/v1/messages',
            id,
            t0,
            model: body.model,
            stream,
            keyInfo,
            status,
            error: e.message,
            account: failAcc,
        });

        if (!res.headersSent) {
            res.status(status).json({ type: 'error', error: { type: 'api_error', message: e.message } });
        } else {
            // 流已开（在吐字中间发生断流）：向客户端发送标准 Anthropic error event，绝不将错误伪造成 assistant 正常回复
            try {
                if (!res.writableEnded) {
                    res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }) + '\n\n');
                    res.end();
                }
            } catch (e2) {}
        }
    }
});

// ===== 辅助端点 =====
router.post('/v1/messages/count_tokens', (req, res) => {
    const { messages, system } = req.body || {};
    let n = 0;
    if (Array.isArray(messages)) for (const m of messages) n += estimateTokens(contentToText(m.content));
    if (system) n += estimateTokens(contentToText(system));
    res.json({ input_tokens: n });
});

router.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
            { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
            { id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'deepseek' },
            { id: 'deepseek-v4.1-flash-thinking', object: 'model', owned_by: 'deepseek' },
        ],
    });
});

module.exports = {
    router,
    sessions,
    injectTools,
    parseToolCalls,
    createToolCallFilter,
};
