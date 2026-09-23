'use strict';
/**
 * src/upload.js — 文件 / 图片上传支持与解析
 * 严格遵循非 C 盘规范，上传缓存落盘于 data/uploads 目录内
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const UPLOAD_ROOT = path.join(config.DATA_DIR, 'uploads');
const MAX_FILE_BYTES = config.MAX_UPLOAD_MB * 1024 * 1024;
const MAX_FILES = 20;

// 确保上传目录存在
config.assertNotCDrive(UPLOAD_ROOT);
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// 允许的扩展名（与 DeepSeek 网页端支持保持一致）
const ALLOWED_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif', '.apng',
    '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml',
    '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
    '.php', '.sh', '.ps1', '.sql', '.css', '.vue', '.scss', '.less', '.ipynb', '.toml', '.ini', '.conf', '.env',
]);

function extOf(name) {
    const m = String(name || '').match(/\.[a-z0-9]+$/i);
    return m ? m[0].toLowerCase() : '';
}

function validate(name, size) {
    const e = extOf(name);
    if (!e) return { ok: false, error: '文件缺少扩展名: ' + name };
    if (!ALLOWED_EXT.has(e)) return { ok: false, error: '不支持的文件类型: ' + e };
    if (size > MAX_FILE_BYTES) return { ok: false, error: `文件过大（上限 ${config.MAX_UPLOAD_MB}MB）: ${name}` };
    return { ok: true };
}

/** 内存缓冲区管理 (fileId -> { id, name, mime, data(base64), size, at }) */
const uploadBuffers = new Map();

/** 最小 multipart/form-data 解析（纯 Node.js，零第三方依赖） */
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
        if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // 结束
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

/** 周期性清理上传缓存与过期文件 */
function startCleanup(maxAgeHours = 24) {
    const ms = Number(maxAgeHours) * 3600 * 1000;
    setInterval(() => {
        try {
            const now = Date.now();
            for (const [id, f] of uploadBuffers.entries()) {
                if (now - f.at > ms) uploadBuffers.delete(id);
            }
            if (fs.existsSync(UPLOAD_ROOT)) {
                for (const d of fs.readdirSync(UPLOAD_ROOT)) {
                    const fp = path.join(UPLOAD_ROOT, d);
                    try {
                        const st = fs.statSync(fp);
                        if (now - st.mtimeMs > ms) {
                            if (st.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
                            else fs.unlinkSync(fp);
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }, 15 * 60 * 1000).unref?.();
}

startCleanup();

module.exports = {
    UPLOAD_ROOT,
    MAX_FILE_BYTES,
    MAX_FILES,
    ALLOWED_EXT,
    uploadBuffers,
    extOf,
    validate,
    parseMultipart,
    startCleanup,
};
