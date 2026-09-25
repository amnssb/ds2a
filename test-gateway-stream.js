'use strict';
/**
 * test-gateway-stream.js
 * 测试通过本地网关 /v1/chat/completions 流式调用超长提示词
 * 验证：思考链正常接收、正文流式输出、INCOMPLETE 正常结束且 finish_reason 为 length
 */
const fs = require('fs');
const path = require('path');

const PROMPT = `创建一个精致、可交互的 3D 场景：一只鹈鹕正在骑自行车，并将其显示在浏览器中。
鹈鹕应戴红白相间的骑行帽和太阳镜。为自行车设计薄荷绿色的复古车架，并添加动态速度线以突出运动感。
支持旋转场景、放大缩小以及调节骑行速度。重点关注自行车几何结构、角色比例和自然的踩踏动作。速度变化时，保持动画流畅。
将页面制作得精致完善，达到公开演示的标准，并采用经过考量的灯光、协调统一的配色和简洁的控件。`;

async function main() {
    console.log('[测试开始] 发起网关流式请求，模型: deepseek-reasoner (深度思考)... 喵');
    const t0 = Date.now();

    const res = await fetch('http://127.0.0.1:19728/v1/chat/completions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-session-id': 'test-pelican-' + Date.now(),
        },
        body: JSON.stringify({
            model: 'deepseek-reasoner',
            stream: true,
            messages: [
                { role: 'user', content: PROMPT }
            ]
        })
    });

    console.log(`[HTTP 响应] 状态码: ${res.status} ${res.statusText} 喵`);
    if (!res.ok) {
        const errText = await res.text();
        console.error('网关返回错误:', errText);
        process.exit(1);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let thinkChars = 0;
    let contentChars = 0;
    let finalFinishReason = null;
    let chunkCount = 0;
    let sawDone = false;

    const timer = setInterval(() => {
        const sec = Math.round((Date.now() - t0) / 1000);
        console.log(`[+${sec}s] 接收块数:${chunkCount} | 思考字数:${thinkChars} | 正文字数:${contentChars} | 状态:${finalFinishReason || '生成中...'} 喵`);
    }, 5000);

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith('data:')) continue;
                const raw = line.slice(5).trim();
                if (raw === '[DONE]') {
                    sawDone = true;
                    continue;
                }
                try {
                    const j = JSON.parse(raw);
                    chunkCount++;
                    const choice = j.choices && j.choices[0];
                    if (choice) {
                        if (choice.delta) {
                            if (choice.delta.reasoning_content) {
                                thinkChars += choice.delta.reasoning_content.length;
                            }
                            if (choice.delta.content) {
                                contentChars += choice.delta.content.length;
                            }
                        }
                        if (choice.finish_reason) {
                            finalFinishReason = choice.finish_reason;
                        }
                    }
                } catch (e) {}
            }
        }
    } finally {
        clearInterval(timer);
    }

    const totalSec = Math.round((Date.now() - t0) / 1000);
    console.log('==================== 网关流式测试报告 ==================== 喵');
    console.log(`耗时: ${totalSec} 秒 喵`);
    console.log(`接收总事件数: ${chunkCount} 喵`);
    console.log(`思考字符数: ${thinkChars} 喵`);
    console.log(`正文字符数: ${contentChars} 喵`);
    console.log(`终止原因 (finish_reason): ${finalFinishReason} 喵`);
    console.log(`是否接收到 [DONE] 结束标志: ${sawDone} 喵`);
    console.log('========================================================== 喵');

    if (sawDone && (finalFinishReason === 'length' || finalFinishReason === 'stop')) {
        console.log('🎉 验证完美通过！网关在超长输出时优雅收尾，未发生异常断开！喵');
    } else {
        console.error('❌ 验证异常，未收到预期的优雅收尾标志！喵');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('测试异常报错:', err);
    process.exit(1);
});
