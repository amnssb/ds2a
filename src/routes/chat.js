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
    if (body && body.user) {
        const u = typeof body.user === 'string' ? body.user : (body.user.id || body.user.name);
        if (u) return { key: String(u).slice(0, 100), ephemeral: false };
    }
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
 * - 上游 accumulated_token_usage 为权威总数（已含 thinking 输出）
 * - 先从总数中扣除 thinking 估算值，避免 60/40 拆分后再叠加 thinking 造成重复计数
 * - 无上游总数时回退为字符启发式估算
 */
function computeUsage(r, fallbackContent, fallbackThinking) {
    const tTokens = estimateTokens(fallbackThinking || r.thinking || '');
    if (r.tokens && r.tokens > 0) {
        const total = Math.max(0, Math.round(r.tokens));
        const t = Math.min(tTokens, total);
        const rest = total - t;
        const p = Math.round(rest * 0.6);
        const c = rest - p;
        return { pTokens: p, cTokens: c, tTokens: t, totalTokens: total };
    }
    const pTokens = estimateTokens(r.prompt);
    const cTokens = estimateTokens(fallbackContent || '');
    return { pTokens, cTokens, tTokens, totalTokens: pTokens + cTokens + tTokens };
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

// ---------- 工具调用协议 ----------
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

function parseToolCalls(text) {
    if (!text || text.indexOf(TC_START) < 0) return { content: text, toolCalls: [] };
    const calls = [];
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc(TC_START) + '([\\s\\S]*?)' + esc(TC_END), 'g');
    const clean = text.replace(re, (m, inner) => {
        const raw = String(inner).trim();
        try {
            const j = JSON.parse(raw);
            for (const it of (Array.isArray(j) ? j : [j])) {
                if (!it || !it.name) continue;
                calls.push({
                    id: 'call_' + crypto.randomBytes(6).toString('hex'),
                    type: 'function',
                    function: {
                        name: String(it.name),
                        arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}),
                    },
                });
            }
        } catch (e) {}
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { content: clean, toolCalls: calls };
}

function createToolCallFilter(hasTools, emit) {
    if (!hasTools) return { push: (d) => emit(d), flush: () => {} };
    const START = TC_START, END = TC_END;
    let buf = '', inToolCall = false;

    function isPartialPrefix(s, target) { return target.startsWith(s); }

    function push(delta) {
        if (!delta) return;
        buf += delta;
        while (buf.length) {
            if (inToolCall) {
                const endIdx = buf.indexOf(END);
                if (endIdx < 0) {
                    for (let k = Math.min(buf.length, END.length - 1); k > 0; k--) {
                        if (isPartialPrefix(buf.slice(-k), END)) return;
                    }
                    buf = '';
                    return;
                }
                buf = buf.slice(endIdx + END.length);
                inToolCall = false;
                continue;
            }
            const startIdx = buf.indexOf(START);
            if (startIdx >= 0) {
                if (startIdx > 0) emit(buf.slice(0, startIdx));
                buf = buf.slice(startIdx + START.length);
                inToolCall = true;
                continue;
            }
            let hold = 0;
            for (let k = Math.min(buf.length, START.length - 1); k > 0; k--) {
                if (isPartialPrefix(buf.slice(-k), START)) { hold = k; break; }
            }
            if (hold > 0) {
                if (buf.length > hold) emit(buf.slice(0, buf.length - hold));
                buf = buf.slice(buf.length - hold);
                return;
            }
            emit(buf);
            buf = '';
            return;
        }
    }
    return { push, flush: () => { if (buf && !inToolCall) emit(buf); buf = ''; } };
}

function resolveApiKey(req) {
    const raw = req.headers.authorization || req.headers['x-api-key'];
    const info = auth.verifyApiKey(raw);
    if (info) return info;
    if (config.REQUIRE_KEY) return null;
    return { keyId: null, name: '(匿名)' };
}

// ---------- 核心执行逻辑（多账号 Failover 故障转移） ----------
async function executeWithFailover(opts) {
    const { body, sessionKey, ephemeral, signal, onThinking, onDelta } = opts;
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
    let lastError = null;

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
        // 若所有账号都已在前面尝试过，无需再次进入 acquire（允许瞬时重试时不立刻 break）
        if (excludedAccounts.length >= accountPool.accounts.length && lastError) {
            const transientStill = lastError && (
                lastError.statusCode === 502 || lastError.statusCode === 504 ||
                /上游网络异常|空响应|连接中断|停滞超时|fetch failed/i.test(lastError.message || '')
            );
            if (!transientStill) break;
            // 瞬时故障：清空排除表做最后一轮重试
            excludedAccounts.length = 0;
        }

        // 会话粘滞账号：已有会话时优先复用原账号（sid/token 必须同账号）
        const prevSess = sessions.get(sessionKey);
        const preferName = prevSess && prevSess.accName ? prevSess.accName : null;

        let account = null;
        try {
            account = accountPool.acquire(excludedAccounts, preferName);
        } catch (e) {
            throw lastError ? lastError : e;
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
                sessions.set(sessionKey, sess);
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

// 空回复兜底（上游有时 200 但正文/思考均为空）
// 与 ds-client.js 保持一致：仅当完全未收到 SSE 事件时才视为空回复
// 若上游返回了事件但内容为空，视为有效响应（可能是上游临时空内容）
// ds-client 已在流结束时处理 sawAnyEvent 逻辑，此处不再额外抛异常
const streamedContent = contentSnapshot();
const streamedThinking = thinkingSnapshot();

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
            const bizCode = err.bizCode || (err.message && err.message.match(/code=(\d+)/) ? Number(err.message.match(/code=(\d+)/)[1]) : null);
            // 客户端主动取消不惩罚账号
            const clientCancel = err && (err.statusCode === 499 || /客户端已中断/i.test(err.message || ''));
            if (!clientCancel) {
                accountPool.markFail(account, err, err.statusCode || 500, bizCode);
            }
            // 瞬时网络/空响应：不立刻排除账号，允许同一请求内快速重试一次
            const transient = !clientCancel && (
                err.statusCode === 502 || err.statusCode === 504 ||
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

    throw lastError || new Error('所有可用账号均尝试失败喵');
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
    const t0 = Date.now();
    const id = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
    const body = req.body || {};
    const stream = !!body.stream;
    const keyInfo = resolveApiKey(req);

    if (!keyInfo) {
        return res.status(401).json({ error: { message: 'API key 无效或缺失喵', type: 'invalid_request_error' } });
    }

    const sess = resolveSessionKey(req, body);

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (res.flushHeaders) res.flushHeaders();
    }

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
            if (!oaiRoleSent) {
                res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant', content: d }, body.model)) + '\n\n');
                oaiRoleSent = true;
            } else {
                res.write('data: ' + JSON.stringify(oaiChunk(id, { content: d }, body.model)) + '\n\n');
            }
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
            res.write('data: ' + JSON.stringify(oaiChunk(id, { role: 'assistant' }, body.model)) + '\n\n');
            oaiRoleSent = true;
        }

        const rawContent = r.content || content;
        const parsed = (r.hasTools || hasTools) ? parseToolCalls(rawContent) : { content: rawContent, toolCalls: [] };
        const finish = parsed.toolCalls.length ? 'tool_calls' : 'stop';

        const { pTokens, cTokens, tTokens, totalTokens } = computeUsage(r, rawContent, thinking);

        // 记录用量与请求日志
        storage.record({
            id,
            at: t0,
            endpoint: '/v1/chat/completions',
            model: body.model || 'deepseek-v4.1-flash',
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

        // OpenAI 官方语义：completion 含 reasoning，total = prompt + completion
        const clientUsage = {
            prompt_tokens: pTokens,
            completion_tokens: cTokens + tTokens,
            total_tokens: totalTokens,
            completion_tokens_details: { reasoning_tokens: tTokens },
        };

        if (stream) {
            for (let i = 0; i < parsed.toolCalls.length; i++) {
                const tc = parsed.toolCalls[i];
                res.write('data: ' + JSON.stringify(oaiChunk(id, { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, body.model)) + '\n\n');
            }
            res.write('data: ' + JSON.stringify(oaiFinish(id, finish, body.model)) + '\n\n');
            // 流式末尾回传 usage（finish 后、[DONE] 前，choices 为空，兼容 stream_options.include_usage 与不带该选项的客户端）
            res.write('data: ' + JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model || 'deepseek-v4.1-flash',
                choices: [],
                usage: clientUsage,
            }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            const msg = { role: 'assistant', content: parsed.toolCalls.length ? (parsed.content || null) : parsed.content };
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

        storage.record({
            id,
            at: t0,
            endpoint: '/v1/chat/completions',
            model: body.model || 'deepseek-v4.1-flash',
            ok: false,
            status: (e.statusCode && e.statusCode >= 400 && e.statusCode < 600) ? e.statusCode : 500,
            ms: Date.now() - t0,
            stream,
            error: e.message,
            keyName: keyInfo.name,
        });

        auth.recordUsage({
            keyId: keyInfo.keyId,
            account: 'failed',
            ok: false,
        });

        const status = (e.statusCode && e.statusCode >= 400 && e.statusCode < 600 && e.statusCode !== 499) ? e.statusCode : 500;
        if (!res.headersSent) {
            res.status(status).json({ error: { message: e.message, type: 'api_error' } });
        } else {
            try {
                res.write('data: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n');
                res.end();
            } catch (e2) {}
        }
    }
});

// ===== Claude 兼容端点 (/v1/messages) =====
router.post('/v1/messages', async (req, res) => {
    const t0 = Date.now();
    const id = 'msg_' + crypto.randomBytes(12).toString('hex');
    const body = req.body || {};
    const stream = !!body.stream;
    const keyInfo = resolveApiKey(req);

    if (!keyInfo) {
        return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'API key 无效或缺失喵' } });
    }

    const sess = resolveSessionKey(req, body);

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (res.flushHeaders) res.flushHeaders();
        // 先按请求内容估算 input_tokens，避免 message_start 恒为 0 导致客户端无法统计入站用量喵
        const estInput = estimateRequestInputTokens(body);
        res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model || 'deepseek-v4.1-flash', content: [], stop_reason: null, usage: { input_tokens: estInput, output_tokens: 0 } } }) + '\n\n');
    }

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
        stopThinkBlock();
        textIdx = nextIdx++;
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } }) + '\n\n');
        return textIdx;
    };

    const ensureThinkBlock = () => {
        if (thinkBlockIdx >= 0) return thinkBlockIdx;
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

        const rawContent = r.content || content;
        const parsed = (r.hasTools || hasTools) ? parseToolCalls(rawContent) : { content: rawContent, toolCalls: [] };
        const finish = parsed.toolCalls.length ? 'tool_use' : 'end_turn';

        // 无 text 增量时也保证至少有一个 text 块（客户端期待固定块序）
        if (stream && textIdx < 0 && !parsed.toolCalls.length) {
            textBlockIndex();
        }

        const { pTokens, cTokens, tTokens } = computeUsage(r, rawContent, thinking);
        const outTokens = cTokens + tTokens;

        storage.record({
            id,
            at: t0,
            endpoint: '/v1/messages',
            model: body.model || 'deepseek-v4.1-flash',
            ok: true,
            status: 200,
            ms: Date.now() - t0,
            stream,
            account: r.accountName,
            keyName: keyInfo.name,
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

        if (stream) {
            // 收尾：先 stop 仍在打开的 text，再 stop 尚未关闭的 thinking
            if (textIdx >= 0) {
                res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: textIdx }) + '\n\n');
            }
            stopThinkBlock();
            res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: finish }, usage: { output_tokens: outTokens } }) + '\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
        } else {
            // 非流式：thinking 必须在 text 之前，thinking 块需带 signature
            const blocks = [];
            if (r.thinking || thinking) {
                blocks.push({ type: 'thinking', thinking: r.thinking || thinking, signature: 'sig_' + id.slice(-8) });
            }
            if (rawContent) blocks.push({ type: 'text', text: rawContent });
            for (const tc of parsed.toolCalls) {
                blocks.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments || '{}'),
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

        // 与 OpenAI 端点对齐：失败请求同样入账，避免 Claude 失败调用在统计中完全丢失喵
        storage.record({
            id,
            at: t0,
            endpoint: '/v1/messages',
            model: body.model || 'deepseek-v4.1-flash',
            ok: false,
            status: (e.statusCode && e.statusCode >= 400 && e.statusCode < 600) ? e.statusCode : 500,
            ms: Date.now() - t0,
            stream,
            error: e.message,
            keyName: keyInfo.name,
        });

        auth.recordUsage({
            keyId: keyInfo.keyId,
            account: 'failed',
            ok: false,
        });

        if (!res.headersSent) {
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: e.message } });
        } else {
            try {
                res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }) + '\n\n');
                res.end();
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
};
