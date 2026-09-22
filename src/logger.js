'use strict';
/**
 * src/logger.js — 日志记录器（异步批量落盘 + 自动滚动 + 安全路径检查）
 * 优化说明：
 *  - 将每条日志的同步 appendFileSync 改为 100ms 批量缓冲异步写入，
 *    避免高并发下日志 I/O 阻塞主事件循环
 *  - 单文件超过 50MB 时自动截断保留最后 5MB（防止磁盘爆满）
 *  - 进程退出前强制同步刷盘，保证日志不丢失
 */
const fs = require('fs');
const config = require('./config');

const colors = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

const MAX_LOG_BYTES = 50 * 1024 * 1024;  // 50MB 滚动阈值
const KEEP_BYTES    = 5  * 1024 * 1024;  // 保留最后 5MB
const FLUSH_INTERVAL_MS = 100;           // 批量刷盘间隔

// 按文件路径分组的写缓冲区
const _buffers = new Map(); // filePath -> string[]
let _flushTimer = null;

function _scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(_flushAll, FLUSH_INTERVAL_MS);
    if (_flushTimer.unref) _flushTimer.unref(); // 不阻止进程正常退出
}

function _flushAll() {
    _flushTimer = null;
    for (const [filePath, lines] of _buffers) {
        if (!lines.length) continue;
        const chunk = lines.join('\n') + '\n';
        _buffers.set(filePath, []);
        try {
            config.assertNotCDrive(filePath);
            fs.appendFileSync(filePath, chunk, 'utf8');
            // 自动滚动：超过阈值时截断保留尾部
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_LOG_BYTES) {
                const fd = fs.openSync(filePath, 'r');
                const buf = Buffer.alloc(KEEP_BYTES);
                fs.readSync(fd, buf, 0, KEEP_BYTES, stat.size - KEEP_BYTES);
                fs.closeSync(fd);
                fs.writeFileSync(filePath, buf, 'utf8');
            }
        } catch (e) {
            // 日志系统自身异常不能崩溃主进程
        }
    }
}

// 进程退出前强制同步刷盘
function _flushSync() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _flushAll();
}
process.on('exit', _flushSync);
process.on('SIGINT', _flushSync);
process.on('SIGTERM', _flushSync);

function enqueue(filePath, line) {
    try { config.assertNotCDrive(filePath); } catch (e) { return; }
    if (!_buffers.has(filePath)) _buffers.set(filePath, []);
    _buffers.get(filePath).push(line);
    _scheduleFlush();
}

function ts() {
    const d = new Date();
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0') + '.' +
        String(d.getMilliseconds()).padStart(3, '0');
}

function log(level, color, icon, msg) {
    const time = ts();
    const cleanMsg = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const consoleLine = `${colors.dim}[${time}]${colors.reset} ${color}${icon}  ${cleanMsg}${colors.reset}`;
    const fileLine = `[${time}] [${level}] ${cleanMsg}`;

    if (level === 'ERROR') {
        console.error(consoleLine);
        enqueue(config.ERR_LOG_FILE, fileLine);
    } else {
        console.log(consoleLine);
    }
    enqueue(config.APP_LOG_FILE, fileLine);
}

module.exports = {
    info:     (msg) => log('INFO',  colors.cyan,    'ℹ️',  msg),
    ok:       (msg) => log('OK',    colors.green,   '✅',  msg),
    warn:     (msg) => log('WARN',  colors.yellow,  '⚠️',  msg),
    err:      (msg) => log('ERROR', colors.red,     '❌',  msg),
    http:     (msg) => log('HTTP',  colors.magenta, '🚀',  msg),
    pow:      (msg) => log('POW',   colors.blue,    '⚡',  msg),
    flushSync: _flushSync,
};
