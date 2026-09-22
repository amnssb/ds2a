'use strict';
/*
 * get-token.js — 从已登录的 Chrome profile 里导出 DeepSeek userToken
 *
 * 只在"添加账号"时用一次，之后网关纯 HTTP 运行，不再需要浏览器。
 *
 * 用法:
 *   node get-token.js <chrome-profile目录> [输出文件]
 * 例:
 *   node get-token.js "C:\path\to\profile" accounts-export.txt
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const requireHere = createRequire(path.join(__dirname, 'package.json'));
const WS = requireHere('ws');

const CHROME = process.env.DS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = process.argv[2];
const outFile = process.argv[3] || path.join(__dirname, 'token-export.txt');
const PORT = Number(process.env.DS_EXPORT_PORT || 9700);

if (!profile) {
    console.log('用法: node get-token.js <chrome-profile目录> [输出文件]');
    console.log('');
    console.log('提示：如果还没有 profile，先手动在 Chrome 里登录 chat.deepseek.com，');
    console.log('      再用 --user-data-dir 指定的目录作为参数。');
    process.exit(1);
}

async function getJson(p) {
    for (let i = 0; i < 80; i++) {
        try { return await (await fetch('http://127.0.0.1:' + p + '/json/version')).json(); }
        catch { await new Promise(r => setTimeout(r, 300)); }
    }
    throw new Error('CDP 无响应');
}

(async () => {
    const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + path.resolve(profile), '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--in-process-gpu',
        '--disable-gpu-sandbox', '--disable-gpu', '--use-angle=swiftshader', 'about:blank'], { stdio: 'ignore' });

    const ver = await getJson(PORT);
    const ws = new WS(ver.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    const waiters = new Map(); let seq = 0;
    ws.on('message', raw => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const send = (method, params, sid) => new Promise((res, rej) => {
        const id = ++seq;
        const t = setTimeout(() => { waiters.delete(id); rej(new Error('CDP 超时 ' + method)); }, 30000);
        waiters.set(id, m => { clearTimeout(t); res(m); });
        ws.send(JSON.stringify(sid ? { id, method, params: params || {}, sessionId: sid } : { id, method, params: params || {} }));
    });

    const ct = await send('Target.createTarget', { url: 'about:blank' });
    const sid = (await send('Target.attachToTarget', { targetId: ct.result.targetId, flatten: true })).result.sessionId;
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);
    const ev = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
        return r.result && r.result.result ? r.result.result.value : undefined;
    };

    console.log('打开 chat.deepseek.com ...');
    await send('Page.navigate', { url: 'https://chat.deepseek.com/' }, sid);
    await new Promise(r => setTimeout(r, 10000));

    const token = await ev('(function(){try{var r=localStorage.getItem("userToken");if(!r)return"";var o=JSON.parse(r);return (o&&o.value)||String(r);}catch(e){return localStorage.getItem("userToken")||""}})()');
    const user = await ev('(function(){try{var u=localStorage.getItem("__appKit_userInfo");return u||"";}catch(e){return""}})()');

    if (!token) {
        console.log('❌ 没找到 userToken（可能没登录）');
        ws.close(); child.kill(); process.exit(1);
    }
    console.log('✅ 已导出 token（长度 ' + token.length + '）');
    fs.writeFileSync(outFile, token, 'utf8');
    console.log('   保存到: ' + outFile);
    console.log('');
    console.log('把这一串贴到面板「账号管理 → 添加账号」的 token 字段即可');

    ws.close(); child.kill();
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
})().catch(e => { console.log('❌ ' + e.message); process.exit(1); });