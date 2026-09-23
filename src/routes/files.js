'use strict';
/**
 * src/routes/files.js — 文件上传与查询接口 (/v1/files)
 * 支持 multipart/form-data 与 JSON base64 两种上传形态
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const upload = require('../upload');
const logger = require('../logger');

const router = express.Router();

// 1. 上传文件接口
router.post(
    '/v1/files',
    express.raw({
        type: 'multipart/form-data',
        limit: `${config.MAX_UPLOAD_MB + 5}mb`,
    }),
    (req, res) => {
        const ct = req.headers['content-type'] || '';

        // Form-data 模式
        if (ct.includes('multipart/form-data')) {
            const p = upload.parseMultipart(req.body, ct);
            if (!p.ok) return res.status(400).json({ error: p.error });
            const fp = p.parts.find(x => x.filename);
            if (!fp) return res.status(400).json({ error: '未找到有效的文件字段 (file/files)' });
            const v = upload.validate(fp.filename, fp.data.length);
            if (!v.ok) return res.status(400).json({ error: v.error });

            const fid = 'f_' + crypto.randomBytes(8).toString('hex');
            const mimeMatch = fp.headers.match(/content-type:\s*([^\r\n]+)/i);
            const mime = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';

            upload.uploadBuffers.set(fid, {
                id: fid,
                name: fp.filename,
                mime,
                data: fp.data.toString('base64'),
                size: fp.data.length,
                at: Date.now(),
            });

            logger.ok(`文件上传成功 (multipart) [${fid}] ${fp.filename} (${Math.round(fp.data.length / 1024)}KB)`);
            return res.json({
                ok: true,
                id: fid,
                file: { id: fid, name: fp.filename, size: fp.data.length, mime },
            });
        }

        // JSON base64 模式
        const b = req.body && Object.keys(req.body).length ? req.body : null;
        if (b && b.data) {
            const cleanBase64 = String(b.data).replace(/^data:[^;]+;base64,/, '');
            const buf = Buffer.from(cleanBase64, 'base64');
            const filename = b.name || 'upload.bin';
            const v = upload.validate(filename, buf.length);
            if (!v.ok) return res.status(400).json({ error: v.error });

            const fid = 'f_' + crypto.randomBytes(8).toString('hex');
            upload.uploadBuffers.set(fid, {
                id: fid,
                name: filename,
                mime: b.mime || 'application/octet-stream',
                data: buf.toString('base64'),
                size: buf.length,
                at: Date.now(),
            });

            logger.ok(`文件上传成功 (base64) [${fid}] ${filename} (${Math.round(buf.length / 1024)}KB)`);
            return res.json({
                ok: true,
                id: fid,
                file: { id: fid, name: filename, size: buf.length, mime: b.mime },
            });
        }

        return res.status(400).json({ error: '请使用 multipart/form-data 或包含 { name, data: base64 } 的 JSON 格式上传喵' });
    }
);

// 2. 获取已上传文件列表
router.get('/v1/files', (req, res) => {
    const list = [...upload.uploadBuffers.values()].map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        at: f.at,
    }));
    res.json({ data: list, files: list });
});

// 3. 删除指定上传文件
router.delete('/v1/files/:id', (req, res) => {
    const ok = upload.uploadBuffers.delete(req.params.id);
    res.json({ ok });
});

module.exports = router;
