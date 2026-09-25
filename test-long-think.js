'use strict';
/**
 * test-long-think.js — 深度思考超长提示词实测脚本
 * 针对账号 a4，开深度思考模式运行鹈鹕 3D 提示词，记录每帧 SSE 与截断原因
 */
const fs = require('fs');
const path = require('path');
const accountPool = require('./src/account-pool');
const ds = require('./src/ds-client');
const logger = require('./src/logger');

const PROMPT = `创建一个精致、可交互的 3D 场景：一只鹈鹕正在骑自行车，并将其显示在浏览器中。
鹈鹕应戴红白相间的骑行帽和太阳镜。为自行车设计薄荷绿色的复古车架，并添加动态速度线以突出运动感。
支持旋转场景、放大缩小以及调节骑行速度。重点关注自行车几何结构、角色比例和自然的踩踏动作。速度变化时，保持动画流畅。
将页面制作得精致完善，达到公开演示的标准，并采用经过考量的灯光、协调统一的配色和简洁的控件。`;

const LOG_FILE = path.join(__dirname, 'logs', 'test-long-think.log');

async function main() {
    const acc = accountPool.accounts.find(a => a.name === 'a4');
    if (!acc) {
        console.error('未找到账号 a4 喵');
        process.exit(1);
    }

    console.log(`[测试开始] 使用账号 ${acc.name} (${acc.email}) 喵`);
    console.log(`[提示词] ${PROMPT.slice(0, 60)}... 喵`);

    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w', encoding: 'utf8' });
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        console.log(line);
        logStream.write(line + '\n');
    };

    const proxy = acc.proxy || '';
    log(`代理配置: ${proxy || '直连'}`);

    log('正在创建专属测试会话...');
    let sid = null;
    try {
        sid = await ds.createSession(acc.token, proxy);
        log(`会话创建成功: sid=${sid}`);
    } catch (e) {
        log(`创建会话失败: ${e.message}`);
        process.exit(1);
    }

    log('正在获取独占 PoW 挑战...');
    const pow = await ds.getPowHeader(acc.token, '/api/v0/chat/completion', proxy);
    log(`PoW 准备就绪`);

    const url = 'https://chat.deepseek.com/api/v0/chat/completion';
    const body = {
        chat_session_id: sid,
        parent_message_id: null,
        model_type: 'default',
        prompt: PROMPT,
        ref_file_ids: [],
        thinking_enabled: true,
        search_enabled: true,
    };

    const headers = {
        'accept': '*/*',
        'content-type': 'application/json',
        'authorization': 'Bearer ' + acc.token,
        'x-client-platform': 'web',
        'x-client-version': '2.5.0',
        'x-client-locale': 'en_US',
        'x-client-bundle-id': 'com.deepseek.chat',
        'referer': 'https://chat.deepseek.com/a/chat/',
        'origin': 'https://chat.deepseek.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'x-ds-pow-response': pow,
        'x-thinking-enabled': '1',
    };

    log('开始发起 POST 请求，监听上游原始 SSE 流...');
    const t0 = Date.now();
    let r;
    try {
        r = await fetch(url, ds.withProxy(proxy, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        }));
    } catch (e) {
        log(`网络请求异常: ${e.message}`);
        process.exit(1);
    }

    log(`上游 HTTP 状态码: ${r.status} ${r.statusText}, Content-Type: ${r.headers.get('content-type')}`);
    if (!r.ok) {
        const text = await r.text();
        log(`上游报错响应: ${text}`);
        process.exit(1);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let thinkChars = 0;
    let contentChars = 0;
    let lastEventTime = Date.now();
    let eventCount = 0;
    let accumulatedTokens = 0;
    let finalStatus = null;
    let finalQuasiStatus = null;
    let stoppedPrematurely = false;
    let lastFrames = [];

    // 定时打印进度
    const progressTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - t0) / 1000);
        const idle = Math.round((Date.now() - lastEventTime) / 1000);
        console.log(`[运行中 ${elapsed}s] 思考: ${thinkChars} 字 | 正文: ${contentChars} 字 | Tokens: ${accumulatedTokens} | 帧数: ${eventCount} | 空闲: ${idle}s`);
    }, 5000);

    const handleLine = (line) => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;

        eventCount++;
        lastEventTime = Date.now();
        lastFrames.push(raw.slice(0, 300));
        if (lastFrames.length > 15) lastFrames.shift();

        let j;
        try { j = JSON.parse(raw); } catch (e) { return; }

        const p = j.p || '';
        // 监控 token
        if (p === 'response/accumulated_token_usage' || p === 'accumulated_token_usage') {
            accumulatedTokens = Number(j.v) || accumulatedTokens;
            log(`[Token 更新] accumulated_token_usage = ${accumulatedTokens}`);
        }
        if (p === 'response/quasi_status' || p === 'quasi_status') {
            finalQuasiStatus = j.v;
            log(`[准状态 quasi_status] ${j.v}`);
        }
        if (p === 'response/status' || p === 'status') {
            finalStatus = j.v;
            log(`[根状态 status] ${j.v}`);
        }

        // 统计思考与正文
        if (typeof j.v === 'string') {
            if (/thinking|think/i.test(p)) {
                thinkChars += j.v.length;
            } else if (/content|text/i.test(p) || p === '') {
                contentChars += j.v.length;
            }
        }
        if (j.v && typeof j.v === 'object') {
            if (Array.isArray(j.v.fragments)) {
                for (const f of j.v.fragments) {
                    if (f.type === 'THINK') thinkChars += (f.content || '').length;
                    else contentChars += (f.content || '').length;
                }
            }
        }
    };

    try {
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch (e) {
                log(`[流式读取异常中断] ${e.message}`);
                stoppedPrematurely = true;
                break;
            }
            if (chunk.done) {
                log('[流式正常结束 EOF]');
                break;
            }
            buf += dec.decode(chunk.value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line) handleLine(line);
            }
        }
    } finally {
        clearInterval(progressTimer);
    }

    const totalSec = Math.round((Date.now() - t0) / 1000);
    log('=================== 测试总结报告 ===================');
    log(`总耗时: ${totalSec} 秒`);
    log(`总事件帧数: ${eventCount}`);
    log(`思考链字符数: ${thinkChars} 字`);
    log(`回答正文字符数: ${contentChars} 字`);
    log(`最终官方累计 Token: ${accumulatedTokens}`);
    log(`最终准状态 (quasi_status): ${finalQuasiStatus}`);
    log(`最终根状态 (status): ${finalStatus}`);
    log(`是否中途异常断流: ${stoppedPrematurely ? '是 (异常中断)' : '否 (正常读取完毕)'}`);
    log('最后接收到的 5 帧内容:');
    lastFrames.slice(-5).forEach((f, i) => log(`  [#${i + 1}] ${f}`));
    log('==================================================');

    // 诊断结论
    if (contentChars === 0 && thinkChars > 0) {
        log('🚨 核心问题复现！思考链输出了很多字，但正文字符数为 0！');
        if (accumulatedTokens >= 4000) {
            log(`👉 原因分析：Token 数量达到 ${accumulatedTokens}，触发了官方单次回复的最大 Token 限制截断！`);
        }
        if (stoppedPrematurely) {
            log('👉 原因分析：网络连接在中途断开导致！');
        }
    } else if (contentChars > 0) {
        log(`🎉 测试成功！思考输出 ${thinkChars} 字，正文输出 ${contentChars} 字！`);
    }

    logStream.end();
}

main().catch(e => {
    console.error('测试异常:', e);
});
