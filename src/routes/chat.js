'use strict';
/**
 * src/routes/chat.js — OpenAI / Claude 兼容对话接口
 * - 自动从 AccountPool 获取健康账号，遇 40003/401 立即熔断并故障转移到下一账号
 * - 每次调用（无论成功或失败）均持久化至 storage，保证重启后数据不丢失
 * - 完整支持 SSE 流式、思考链 (thinking)、工具调用 (tools)、图片/文档内联
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const storage = require('../storage');
const accountPool = require('../account-pool');
const ds = require('../ds-client');
const auth = require('../auth');

const router = express.Router();

// ---------- 会话管理（DS parent_message_id 续接） ----------
const sessions = new Map(); // sessionKey -> { sid, parent, token, accName, lastUsed, ephemeral }

// 定期清理闲置会话
setInterval(async () => {
    const now = Date.now();
    for (const [k, v] of sessions.entries()) {
        if (now - v.lastUsed > config.SESSION_TTL_MS) {
            sessions.delete(k);
            await ds.deleteSession(v.token, v.sid).catch(() => {});
        }
    }
}, 30000);

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
        if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++; else other++;
    }
    return Math.ceil(cjk + other / 4);
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
    if (/-think(ing)?$/.test(m) || /reasoner|deepseek-r1$/.test(m)) return true;
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

// ---------- 核心执行逻辑（含多账号 Failover 故障转移） ----------
async function executeWithFailover(opts) {
    const { body, sessionKey, ephemeral, signal, onThinking, onDelta } = opts;
    const thinking = resolveThinking(body);
    const search = resolveSearch(body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const inlineFiles = extractInlineFiles(body.messages || []);
    const fileIds = Array.isArray(body.file_ids) ? [...body.file_ids] : [];

    const excludedAccounts = [];
    let lastError = null;

    // 最多尝试池中的可用账号数（至多 5 次）
    const maxTries = Math.min(Math.max(1, accountPool.accounts.length), 5);

    for (let attempt = 0; attempt < maxTries; attempt++) {
        let account = null;
        try {
            account = accountPool.acquire(excludedAccounts);
        } catch (e) {
            throw new Error(lastError ? `${lastError.message}（且${e.message}）` : e.message);
        }

        try {
            let sess = sessions.get(sessionKey);
            let isNew = !sess;

            // 1. 会话建立
            if (!sess) {
                const sid = await ds.createSession(account.token);
                sess = {
                    sid,
                    parent: null,
                    token: account.token,
                    accName: account.name,
                    lastUsed: Date.now(),
                    ephemeral: !!ephemeral,
                };
                sessions.set(sessionKey, sess);
                logger.info(`新建会话 ${sessionKey} → 账号: ${account.name} | sid: ${sid.slice(0, 8)}`);
            }
            sess.lastUsed = Date.now();

            // 2. 附件上传
            if (inlineFiles.length) {
                for (const f of inlineFiles) {
                    const fid = await ds.uploadFile(account.token, f.name, f.data, f.mime, 'default');
                    await ds.waitFileReady(account.token, fid, 60000);
                    fileIds.push(fid);
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
                refFileIds: fileIds,
                onEvent: (ty, d) => {
                    if (ty === 'thinking') onThinking(d);
                    else if (ty === 'content') onDelta(d);
                },
                signal,
            });

            if (r.messageId) sess.parent = r.messageId;
            accountPool.markOk(account);

            // 一次性会话清理
            if (sess.ephemeral) {
                sessions.delete(sessionKey);
                ds.deleteSession(account.token, sess.sid).catch(() => {});
            }

            return {
                ...r,
                accountName: account.name,
                thinkingEnabled: thinking,
                search,
                hasTools,
                prompt: finalPrompt,
            };
        } catch (err) {
            lastError = err;
            const bizCode = err.bizCode || (err.message && err.message.match(/code=(\d+)/) ? Number(err.message.match(/code=(\d+)/)[1]) : null);
            accountPool.markFail(account, err, err.statusCode || 500, bizCode);
            excludedAccounts.push(account.name);
            logger.warn(`账号 ${account.name} 调用异常，正在尝试故障转移... (已排除: ${excludedAccounts.join(', ')})`);
        } finally {
            if (account) accountPool.release(account);
        }
    }

    throw lastError || new Error('所有可用账号均尝试失败喵');
}

// ===== OpenAI 兼容端点 =====
function oaiChunk(id, delta) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4.1-flash',
        choices: [{ index: 0, delta, finish_reason: null }],
    };
}
function oaiFinish(id, reason) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4.1-flash',
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
    req.on('close', () => ac.abort());

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const filter = createToolCallFilter(hasTools, (d) => {
        content += d;
        if (stream) res.write('data: ' + JSON.stringify(oaiChunk(id, { content: d })) + '\n\n');
    });

    try {
        const r = await executeWithFailover({
            body,
            sessionKey: sess.key,
            ephemeral: sess.ephemeral,
            signal: ac.signal,
            onThinking: d => {
                thinking += d;
                if (stream) res.write('data: ' + JSON.stringify(oaiChunk(id, { reasoning_content: d })) + '\n\n');
            },
            onDelta: d => filter.push(d),
        });
        filter.flush();

        const rawContent = r.content || content;
        const parsed = (r.hasTools || hasTools) ? parseToolCalls(rawContent) : { content, toolCalls: [] };
        const finish = parsed.toolCalls.length ? 'tool_calls' : 'stop';

        const pTokens = r.tokens ? Math.round(r.tokens * 0.6) : estimateTokens(r.prompt);
        const cTokens = r.tokens ? Math.round(r.tokens * 0.4) : estimateTokens(content);
        const tTokens = estimateTokens(thinking);

        // 无论成功还是失败，永久落盘至 storage
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

        // 记入 auth 用量
        auth.recordUsage({
            keyId: keyInfo.keyId,
            account: r.accountName,
            ok: true,
            promptTokens: pTokens,
            completionTokens: cTokens,
            thinkingTokens: tTokens,
        });

        if (stream) {
            for (let i = 0; i < parsed.toolCalls.length; i++) {
                const tc = parsed.toolCalls[i];
                res.write('data: ' + JSON.stringify(oaiChunk(id, { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] })) + '\n\n');
            }
            res.write('data: ' + JSON.stringify(oaiFinish(id, finish)) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            const msg = { role: 'assistant', content: parsed.toolCalls.length ? (parsed.content || null) : parsed.content };
            if (thinking) msg.reasoning_content = thinking;
            if (parsed.toolCalls.length) msg.tool_calls = parsed.toolCalls;

            res.json({
                id,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: body.model || 'deepseek-v4.1-flash',
                choices: [{ index: 0, message: msg, finish_reason: finish }],
                usage: {
                    prompt_tokens: pTokens,
                    completion_tokens: cTokens,
                    total_tokens: pTokens + cTokens,
                },
            });
        }

        logger.ok(`完成请求 ${Date.now() - t0}ms | 正文:${content.length}字 思考:${thinking.length}字 | 账号: ${r.accountName}`);
    } catch (e) {
        logger.err('chat/completions 失败: ' + e.message);

        storage.record({
            id,
            at: t0,
            endpoint: '/v1/chat/completions',
            model: body.model || 'deepseek-v4.1-flash',
            ok: false,
            status: 500,
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
            res.status(500).json({ error: { message: e.message, type: 'api_error' } });
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
    }

    let content = '', thinking = '';
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
        if (stream) {
            res.write('event: message_start\ndata: ' + JSON.stringify({
                type: 'message_start',
                message: { id, type: 'message', role: 'assistant', model: body.model || 'claude-3-5-sonnet', content: [], usage: { input_tokens: 0, output_tokens: 0 } }
            }) + '\n\n');
        }

        const r = await executeWithFailover({
            body,
            sessionKey: sess.key,
            ephemeral: sess.ephemeral,
            signal: ac.signal,
            onThinking: d => {
                thinking += d;
                if (stream) res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: d } }) + '\n\n');
            },
            onDelta: d => {
                content += d;
                if (stream) res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: d } }) + '\n\n');
            },
        });

        const pTokens = r.tokens ? Math.round(r.tokens * 0.6) : estimateTokens(r.prompt);
        const cTokens = r.tokens ? Math.round(r.tokens * 0.4) : estimateTokens(content);
        const tTokens = estimateTokens(thinking);

        storage.record({
            id,
            at: t0,
            endpoint: '/v1/messages',
            model: body.model || 'claude-3-5-sonnet',
            ok: true,
            status: 200,
            ms: Date.now() - t0,
            stream,
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

        if (stream) {
            res.write('event: message_delta\ndata: ' + JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: cTokens }
            }) + '\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
        } else {
            const contentBlocks = [];
            if (thinking) contentBlocks.push({ type: 'thinking', thinking });
            contentBlocks.push({ type: 'text', text: content });

            res.json({
                id,
                type: 'message',
                role: 'assistant',
                model: body.model || 'claude-3-5-sonnet',
                content: contentBlocks,
                stop_reason: 'end_turn',
                usage: { input_tokens: pTokens, output_tokens: cTokens },
            });
        }
    } catch (e) {
        logger.err('v1/messages 失败: ' + e.message);

        storage.record({
            id,
            at: t0,
            endpoint: '/v1/messages',
            model: body.model || 'claude-3-5-sonnet',
            ok: false,
            status: 500,
            ms: Date.now() - t0,
            stream,
            error: e.message,
            keyName: keyInfo.name,
        });

        if (!res.headersSent) {
            res.status(500).json({ type: 'error', error: { type: 'api_error', message: e.message } });
        } else {
            try {
                res.write('event: error\ndata: ' + JSON.stringify({ error: { message: e.message } }) + '\n\n');
                res.end();
            } catch (e2) {}
        }
    }
});

module.exports = router;
