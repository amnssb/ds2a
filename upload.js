'use strict';
/*
 * upload.js — 文件 / 图片上传支持
 *
 * 流程：
 *   1. 接收 multipart/form-data 或 JSON(base64)
 *   2. 存到 uploads/<sessionId>/ 下
 *   3. 通过 WS 把本地绝对路径下发给标签页（浏览器进程与本机同机，可直接读文件）
 *   4. client.js 用 CDP 由宿主调 DOM.setFileInputFiles 注入 input[type=file]
 *
 * 注意：DOM.setFileInputFiles 需要 CDP，client.js 在页面里无法直接设 FileList，
 * 所以宿主页面侧改走 DataTransfer 构造 File 的方式注入（见 client.js injectFiles）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const MAX_FILE_BYTES = Number(process.env.DS_MAX_UPLOAD_MB || 30) * 1024 * 1024;
const MAX_FILES = 10;

// 允许的 MIME（图片 + 常见文档，和 ds 页面 accept 基本对齐）
const ALLOWED_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif', '.apng',
    '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml',
    '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
    '.php', '.sh', '.ps1', '.sql', '.css', '.vue', '.scss', '.less', '.ipynb', '.toml', '.ini', '.conf', '.env',
]);

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function extOf(name) {
    const m = String(name || '').match(/\.[a-z0-9]+$/i);
    return m ? m[0].toLowerCase() : '';
}

/** 校验单个文件，返回 { ok, error } */
function validate(name, size) {
    const e = extOf(name);
    if (!e) return { ok: false, error: '文件缺少扩展名: ' + name };
    if (!ALLOWED_EXT.has(e)) return { ok: false, error: '不支持的文件类型: ' + e };
    if (size > MAX_FILE_BYTES) return { ok: false, error: '文件过大（上限 ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + 'MB）: ' + name };
    return { ok: true };
}

/** 保存一个 buffer 到会话目录，返回记录 */
function saveBuffer(sessionId, originalName, buffer) {
    const v = validate(originalName, buffer.length);
    if (!v.ok) return { ok: false, error: v.error };
    const dir = path.join(UPLOAD_ROOT, String(sessionId).replace(/[^\w.-]/g, '_').slice(0, 60));
    ensureDir(dir);
    const safeName = path.basename(originalName).replace(/[^\w.一-龥-]/g, '_').slice(0, 120);
    const stored = crypto.randomBytes(4).toString('hex') + '_' + safeName;
    const full = path.join(dir, stored);
    fs.writeFileSync(full, buffer);
    return {
        ok: true,
        file: {
            name: safeName,
            path: full,
            size: buffer.length,
            ext: extOf(safeName),
            isImage: /^\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?|avif|apng)$/i.test(extOf(safeName)),
            uploadedAt: Date.now(),
        },
    };
}

/** 最小 multipart/form-data 解析（无第三方依赖） */
function parseMultipart(buffer, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) return { ok: false, error: '缺少 boundary' };
    const boundary = '--' + (m[1] || m[2]).trim();
    const bBuf = Buffer.from(boundary);
    const parts = [];
    let idx = buffer.indexOf(bBuf);
    if (idx < 0) return { ok: false, error: '未找到 boundary' };

    while (true) {
        let start = idx + bBuf.length;
        if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;   // 结束
        if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
        const next = buffer.indexOf(bBuf, start);
        if (next < 0) break;
        const chunk = buffer.slice(start, next);
        const headEnd = chunk.indexOf('\r\n\r\n');
        if (headEnd > 0) {
            const headers = chunk.slice(0, headEnd).toString('utf8');
            let body = chunk.slice(headEnd + 4);
            if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
                body = body.slice(0, body.length - 2);
            }
            const nameM = /name="([^"]*)"/i.exec(headers);
            const fileM = /filename="([^"]*)"/i.exec(headers);
            parts.push({
                name: nameM ? nameM[1] : '',
                filename: fileM ? fileM[1] : null,
                data: body,
                headers,
            });
        }
        idx = next;
    }
    return { ok: true, parts };
}

/** 会话上传目录 */
function sessionDir(sessionId) {
    const dir = path.join(UPLOAD_ROOT, String(sessionId).replace(/[^\w.-]/g, '_').slice(0, 60));
    ensureDir(dir);
    return dir;
}

/** 清理某个会话的上传文件 */
function clearSession(sessionId) {
    const dir = sessionDir(sessionId);
    let n = 0;
    try {
        for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) {}
        }
    } catch (e) {}
    return n;
}

/** 周期性清理超过 N 小时的上传文件 */
function startCleanup(maxAgeHours) {
    const ms = (Number(maxAgeHours) || 24) * 3600 * 1000;
    setInterval(() => {
        try {
            if (!fs.existsSync(UPLOAD_ROOT)) return;
            const now = Date.now();
            for (const d of fs.readdirSync(UPLOAD_ROOT)) {
                const dp = path.join(UPLOAD_ROOT, d);
                if (!fs.statSync(dp).isDirectory()) continue;
                let empty = true;
                for (const f of fs.readdirSync(dp)) {
                    const fp = path.join(dp, f);
                    if (now - fs.statSync(fp).mtimeMs > ms) { try { fs.unlinkSync(fp); } catch (e) {} }
                    else empty = false;
                }
                if (empty) { try { fs.rmdirSync(dp); } catch (e) {} }
            }
        } catch (e) {}
    }, 30 * 60 * 1000).unref?.();
}

module.exports = {
    saveBuffer, parseMultipart, sessionDir, clearSession, startCleanup,
    validate, extOf, ALLOWED_EXT, UPLOAD_ROOT, MAX_FILE_BYTES, MAX_FILES,
};