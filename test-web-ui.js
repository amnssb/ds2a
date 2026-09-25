'use strict';
/**
 * test-web-ui.js — 有头 Chrome 真实网页自动化测试
 * 1. 启动有头 Chrome 访问 https://chat.deepseek.com
 * 2. 自动登录 a4 账号（带 CN 双层切换）
 * 3. 勾选深度思考 (R1)
 * 4. 自动输入鹈鹕 3D 提示词并发送
 * 5. 全程监控网页状态、控制台日志与网络响应
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const WS = require('ws');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\amnssb\\Documents\\ds-browserless\\.chrome-profiles\\login-headful-a4';
const PORT = 9876;
const PROMPT = `创建一个精致、可交互的 3D 场景：一只鹈鹕正在骑自行车，并将其显示在浏览器中。
鹈鹕应戴红白相间的骑行帽和太阳镜。为自行车设计薄荷绿色的复古车架，并添加动态速度线以突出运动感。
支持旋转场景、放大缩小以及调节骑行速度。重点关注自行车几何结构、角色比例和自然的踩踏动作。速度变化时，保持动画流畅。
将页面制作得精致完善，达到公开演示的标准，并采用经过考量的灯光、协调统一的配色和简洁的控件。`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(port) {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            return await r.json();
        } catch (e) {
            await sleep(300);
        }
    }
    throw new Error('Chrome 调试端口无响应: ' + port);
}

class CdpClient {
    constructor(wsUrl) {
        this.ws = new WS(wsUrl);
        this.seq = 0;
        this.waiters = new Map();
        this.listeners = new Map();
        this.ws.on('message', raw => {
            try {
                const m = JSON.parse(raw.toString());
                if (m.id && this.waiters.has(m.id)) {
                    this.waiters.get(m.id)(m);
                    this.waiters.delete(m.id);
                }
                if (m.method && this.listeners.has(m.method)) {
                    this.listeners.get(m.method)(m.params);
                }
            } catch (e) {}
        });
    }
    init() {
        return new Promise((res, rej) => {
            this.ws.once('open', res);
            this.ws.once('error', rej);
        });
    }
    send(method, params = {}, sid = null) {
        return new Promise((res, rej) => {
            const id = ++this.seq;
            const t = setTimeout(() => { this.waiters.delete(id); rej(new Error('CDP 超时 ' + method)); }, 45000);
            this.waiters.set(id, m => { clearTimeout(t); res(m); });
            this.ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
        });
    }
    on(event, fn) {
        this.listeners.set(event, fn);
    }
    async evaluate(expr, sid) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
        const res = r.result || {};
        if (res.exceptionDetails) throw new Error('执行异常: ' + JSON.stringify(res.exceptionDetails));
        return res.result ? res.result.value : undefined;
    }
}

async function main() {
    console.log('🚀 正在启动有头 Chrome 浏览器进行现场复现测试...');
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const chromeProc = spawn(CHROME, [
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + PROFILE_DIR,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,850',
        'https://chat.deepseek.com/'
    ], { stdio: 'ignore' });

    console.log(`Chrome 已启动 (PID: ${chromeProc.pid})，正在连接 CDP 调试接口...`);
    const ver = await getJson(PORT);
    const client = new CdpClient(ver.webSocketDebuggerUrl);
    await client.init();

    // 绑定到主页面 Target
    const targets = await client.send('Target.getTargets');
    const infos = (targets.result && targets.result.targetInfos) || targets.targetInfos || [];
    let pageTarget = infos.find(t => t.type === 'page' && t.url.includes('deepseek.com'));
    if (!pageTarget) {
        pageTarget = infos.find(t => t.type === 'page');
    }
    if (!pageTarget) throw new Error('未找到主页面 Target');
    const attach = await client.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const sid = attach.sessionId;

    await client.send('Page.enable', {}, sid);
    await client.send('Runtime.enable', {}, sid);
    await client.send('Network.enable', {}, sid);

    // 监听网络请求完成与报错
    client.on('Network.responseReceived', (p) => {
        if (p.response && p.response.url && p.response.url.includes('/api/v0/chat/completion')) {
            console.log(`[Network Response] status=${p.response.status} url=${p.response.url}`);
        }
    });
    client.on('Network.loadingFailed', (p) => {
        console.log(`[Network Error] requestId=${p.requestId} errorText=${p.errorText} canceled=${p.canceled}`);
    });
    client.on('Network.loadingFinished', (p) => {
        console.log(`[Network Finished] requestId=${p.requestId}`);
    });

    console.log('等待页面加载 4 秒...');
    await sleep(4000);

    // 检查是否在登录页面
    const currentUrl = await client.evaluate('window.location.href', sid);
    console.log('当前页面 URL:', currentUrl);

    if (currentUrl.includes('/sign_in') || currentUrl.includes('/login')) {
        console.log('检测到处于登录页，执行自动登录（带 CN 双层切换）...');
        const dsLogin = require('./src/ds-login');
        // 借用 session
        const sess = new dsLogin.BrowserSession(PORT, false, 'a4');
        sess.ws = client.ws;
        sess.sid = sid;
        const loginRes = await sess.fillAndSubmitLogin({
            email: 'AdrianneKrumenacker1893388@outlook.com',
            password: 'umirf337031'
        });
        console.log('表单自动填充并提交结果:', loginRes);
        console.log('等待登录完成或人工过验证码（若有）...');
        for (let i = 0; i < 40; i++) {
            await sleep(1000);
            const tok = await client.evaluate('localStorage.getItem("userToken")', sid);
            if (tok && tok.length > 20) {
                console.log('✅ 登录成功，userToken 就绪！');
                break;
            }
        }
        await sleep(3000);
    }

    // 确认进入聊天页面
    console.log('正在寻找并激活「深度思考 (R1)」开关...');
    const switchR1 = await client.evaluate(`(function(){
        // 查找深度思考按钮
        const btns = [...document.querySelectorAll('button, div[role="button"], span, .ds-switch')];
        const r1Btn = btns.find(b => {
            const t = (b.textContent || '').trim();
            return (t.includes('深度思考') || t.includes('R1')) && b.offsetParent !== null;
        });
        if (r1Btn) {
            const active = r1Btn.getAttribute('aria-checked') === 'true' || r1Btn.classList.contains('is-active') || r1Btn.classList.contains('active');
            if (!active) {
                (r1Btn.closest('button, div[role="button"]') || r1Btn).click();
                return 'clicked_r1';
            }
            return 'already_r1';
        }
        return 'not_found_r1';
    })()`, sid);
    console.log('深度思考按钮状态:', switchR1);

    // 填充输入框
    console.log('正在填入超长 3D 鹈鹕提示词...');
    const inputRes = await client.evaluate(`(function(){
        const input = document.querySelector('textarea, [contenteditable="true"]');
        if (!input) return 'no-input';
        
        if (input.tagName === 'TEXTAREA') {
            const proto = Object.getPrototypeOf(input);
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(input, ${JSON.stringify(PROMPT)});
            else input.value = ${JSON.stringify(PROMPT)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            input.focus();
            input.innerText = ${JSON.stringify(PROMPT)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return 'filled';
    })()`, sid);
    console.log('输入框填充结果:', inputRes);

    await sleep(800);

    // 点击发送
    console.log('正在点击发送按钮...');
    const sendRes = await client.evaluate(`(function(){
        const btns = [...document.querySelectorAll('button, div[role="button"]')];
        const sendBtn = btns.find(b => {
            return b.querySelector('svg') && (b.offsetWidth > 15) && !b.disabled && b.offsetParent !== null;
        }) || document.querySelector('.ds-send-button') || document.querySelector('button[type="submit"]');
        if (sendBtn) {
            sendBtn.click();
            return 'clicked_send';
        }
        return 'no_send_btn';
    })()`, sid);
    console.log('发送按钮点击结果:', sendRes);

    console.log('正在实时观测网页深度思考与正文生成...');
    const t0 = Date.now();
    for (let sec = 1; sec <= 180; sec++) {
        await sleep(3000);
        const status = await client.evaluate(`(function(){
            // 抓取思考中状态、思考内容字数、正文字数
            const thinkBox = document.querySelector('.ds-thought, [class*="thought" i], [class*="thinking" i]');
            const thinkText = thinkBox ? thinkBox.innerText : '';
            
            const markdownBody = document.querySelector('.ds-markdown, .markdown, [class*="markdown" i]');
            const bodyText = markdownBody ? markdownBody.innerText : '';
            
            const stopBtn = document.querySelector('[class*="stop" i], button[aria-label*="停止" i]');
            const errorBanner = document.querySelector('.ds-toast, .ds-message--error, [class*="error" i]');
            
            return {
                isGenerating: !!stopBtn,
                thinkLen: thinkText.length,
                thinkPreview: thinkText.slice(-60),
                bodyLen: bodyText.length,
                bodyPreview: bodyText.slice(-60),
                error: errorBanner ? errorBanner.innerText : ''
            };
        })()`, sid);

        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[+${elapsed}s] 正在生成:${status.isGenerating} | 思考:${status.thinkLen}字 | 正文:${status.bodyLen}字 | 报错:${status.error || '无'}`);

        if (status.thinkLen > 0 && status.thinkPreview) {
            console.log(`   💭 思考最新尾部: "...${status.thinkPreview.replace(/\\n/g, ' ')}"`);
        }
        if (status.bodyLen > 0 && status.bodyPreview) {
            console.log(`   📝 正文最新尾部: "...${status.bodyPreview.replace(/\\n/g, ' ')}"`);
        }

        if (!status.isGenerating && elapsed > 15 && (status.thinkLen > 0 || status.bodyLen > 0)) {
            console.log('🏁 模型输出全部结束！');
            break;
        }
    }

    console.log('测试完成，保留浏览器窗口供观察 2 分钟...');
    await sleep(120000);
}

main().catch(e => {
    console.error('网页测试异常:', e);
});
