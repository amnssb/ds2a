'use strict';
/**
 * src/storage.js — 运行时统计与请求日志持久化模块
 * 解决“重启后日志与 Token 记录丢失”的问题，落盘全部写入 D 盘 data/ 目录
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// requests.jsonl 轮转配置：超过阈值滚动为 .1/.2/.3，最旧的直接删除
const REQUESTS_ROTATE_BYTES = Math.max(1, Number(process.env.DS_REQUESTS_ROTATE_MB || 20)) * 1024 * 1024;
const REQUESTS_KEEP_ROTATIONS = Math.max(1, Number(process.env.DS_REQUESTS_KEEP || 3));
// 启动时只读文件末尾，避免大文件全量同步读取阻塞启动
const BOOT_TAIL_BYTES = 2 * 1024 * 1024;
// 按日统计保留天数
const DAY_STATS_KEEP_DAYS = Math.max(1, Number(process.env.DS_STATS_KEEP_DAYS || 30));

// 只读取流水日志末尾若干字节；文件超限时从最后一个完整行开始，避免解析半行残片
function readRequestsTail(file) {
    const st = fs.statSync(file);
    if (st.size <= BOOT_TAIL_BYTES) {
        return fs.readFileSync(file, 'utf8');
    }
    const start = st.size - BOOT_TAIL_BYTES;
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
        let read = 0;
        while (read < len) {
            const n = fs.readSync(fd, buf, read, len - read, start + read);
            if (n <= 0) break;
            read += n;
        }
        let content = buf.toString('utf8');
        const nl = content.indexOf('\n');
        content = nl >= 0 ? content.slice(nl + 1) : '';
        return content;
    } finally {
        fs.closeSync(fd);
    }
}

class PersistentStorage {
    constructor() {
        this.statsFile = config.STATS_FILE;
        this.requestsFile = config.REQUESTS_LOG_FILE;
        this.startedAt = Date.now();

        // 内存缓存
        this.lifetime = {
            total: 0,
            ok: 0,
            err: 0,
            stream: 0,
            tools: 0,
            thinking: 0,
            search: 0,
            files: 0,
            latencySum: 0,
            tokens: {
                total: 0,
                prompt: 0,
                completion: 0,
                thinking: 0,
            },
            byDay: {},
            byAccount: {},
            byModel: {},
        };

        this.recent = []; // 最近 500 条请求
        this.errors = []; // 最近 100 条错误
        this._writeBuffer = [];
        this._saveTimer = null;
        this._needsStatsFlush = false;

        this.init();
    }

    init() {
        config.assertNotCDrive(this.statsFile);
        config.assertNotCDrive(this.requestsFile);

        // 1. 加载持久化聚合统计
        if (fs.existsSync(this.statsFile)) {
            try {
                const raw = fs.readFileSync(this.statsFile, 'utf8');
                const loaded = JSON.parse(raw);
                if (loaded && typeof loaded === 'object') {
                    this.lifetime = Object.assign(this.lifetime, loaded);
                }
            } catch (e) {
                // 忽略破损文件并备份
            }
        }

        // 2. 加载最近历史请求（大文件只读尾部，避免启动阻塞）
        if (fs.existsSync(this.requestsFile)) {
            try {
                const content = readRequestsTail(this.requestsFile);
                const lines = content.trim().split('\n').filter(Boolean);
                // 取最后 500 条，按时间降序（最新在前）
                const slice = lines.slice(-500);
                for (const line of slice) {
                    try {
                        const item = JSON.parse(line);
                        this.recent.push(item); // 先按升序收集
                        if (!item.ok && item.error) {
                            this.errors.push({
                                at: item.at,
                                endpoint: item.endpoint,
                                account: item.account,
                                error: item.error,
                            });
                        }
                    } catch (e) {}
                }
                // 反转为降序（最新在前），与 record() 中 unshift 语义一致
                this.recent.reverse();
                this.recent.length = Math.min(this.recent.length, 500);
                this.errors.reverse();
                if (this.errors.length > 100) this.errors.length = 100;
            } catch (e) {}
        }

        // 3. 定时自动落盘
        this._saveTimer = setInterval(() => this.flush(), 5000);
        this._saveTimer.unref();

        // 4. 退出钩子
        const handleExit = () => {
            this.flushSync();
        };
        process.on('SIGINT', handleExit);
        process.on('SIGTERM', handleExit);
        process.on('beforeExit', handleExit);
    }

    dayKey(t) {
        const d = new Date(t || Date.now());
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    /** 记录一次请求详情与用量 */
    record(info) {
        const at = info.at || Date.now();
        const item = {
            id: info.id || ('req-' + Math.random().toString(36).slice(2, 9)),
            at,
            endpoint: info.endpoint || '/v1/chat/completions',
            model: info.model || 'deepseek-v4.1-flash',
            ok: !!info.ok,
            status: info.status || (info.ok ? 200 : 500),
            ms: info.ms || 0,
            stream: !!info.stream,
            tools: !!info.tools,
            thinking: !!info.thinking,
            search: !!info.search,
            account: info.account || 'unknown',
            keyName: info.keyName || '(匿名)',
            session: info.session || '',
            ephemeral: !!info.ephemeral,
            error: info.error ? String(info.error).slice(0, 500) : null,
            tokens: {
                prompt: info.promptTokens || 0,
                completion: info.completionTokens || 0,
                thinking: info.thinkingTokens || 0,
                total: (info.promptTokens || 0) + (info.completionTokens || 0) + (info.thinkingTokens || 0),
            },
        };

        // 更新内存队列
        this.recent.unshift(item);
        if (this.recent.length > 500) this.recent.length = 500;

        if (!item.ok && item.error) {
            this.errors.unshift({
                at: item.at,
                endpoint: item.endpoint,
                account: item.account,
                error: item.error,
            });
            if (this.errors.length > 100) this.errors.length = 100;
        }

        // 更新聚合统计
        this.lifetime.total++;
        if (item.ok) this.lifetime.ok++; else this.lifetime.err++;
        if (item.stream) this.lifetime.stream++;
        if (item.tools) this.lifetime.tools++;
        if (item.thinking) this.lifetime.thinking++;
        if (item.search) this.lifetime.search++;
        if (info.files) this.lifetime.files += info.files;
        if (item.ms) this.lifetime.latencySum += item.ms;

        this.lifetime.tokens.prompt += item.tokens.prompt;
        this.lifetime.tokens.completion += item.tokens.completion;
        this.lifetime.tokens.thinking += item.tokens.thinking;
        this.lifetime.tokens.total += item.tokens.total;

        // 按日统计
        const dk = this.dayKey(at);
        if (!this.lifetime.byDay[dk]) {
            this.lifetime.byDay[dk] = { requests: 0, ok: 0, err: 0, tokens: 0, promptTokens: 0, completionTokens: 0, thinkingTokens: 0 };
        }
        const day = this.lifetime.byDay[dk];
        day.requests++;
        if (item.ok) day.ok++; else day.err++;
        day.tokens += item.tokens.total;
        day.promptTokens += item.tokens.prompt;
        day.completionTokens += item.tokens.completion;
        day.thinkingTokens = (day.thinkingTokens || 0) + item.tokens.thinking;

        // 按账号统计
        const acc = item.account;
        if (!this.lifetime.byAccount[acc]) {
            this.lifetime.byAccount[acc] = { requests: 0, ok: 0, err: 0, tokens: 0 };
        }
        this.lifetime.byAccount[acc].requests++;
        if (item.ok) this.lifetime.byAccount[acc].ok++; else this.lifetime.byAccount[acc].err++;
        this.lifetime.byAccount[acc].tokens += item.tokens.total;

        // 写入队列
        this._writeBuffer.push(JSON.stringify(item));
    }

    /** 异步落盘（含流水日志轮转与过期统计清理） */
    flush() {
        if (!this._writeBuffer.length && !this._needsStatsFlush) {
            // 无新数据也周期性触发轮转检查，保证无人写入时大文件同样会被滚动
            this._rotateRequestsIfNeeded();
            return;
        }
        const chunk = this._writeBuffer.length ? (this._writeBuffer.join('\n') + '\n') : '';
        this._writeBuffer = [];

        try {
            this._rotateRequestsIfNeeded();
            config.assertNotCDrive(this.requestsFile);
            if (chunk) fs.appendFileSync(this.requestsFile, chunk, 'utf8');
            // 追加后复查一次：本次写入刚好越过阈值时立刻轮转，不必等下一个周期
            this._rotateRequestsIfNeeded();
        } catch (e) {
            console.error('[storage] 追加日志失败:', e.message);
        }

        try {
            this._pruneOldDayStats();
            config.assertNotCDrive(this.statsFile);
            const tmp = this.statsFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.lifetime, null, 2), 'utf8');
            fs.renameSync(tmp, this.statsFile);
            this._needsStatsFlush = false;
        } catch (e) {
            console.error('[storage] 保存聚合统计失败:', e.message);
        }
    }

    /** requests.jsonl 超过阈值时滚动为 .1/.2/.3，最旧的删除 */
    _rotateRequestsIfNeeded() {
        let size = 0;
        try { size = fs.statSync(this.requestsFile).size; } catch (e) { return; }
        if (size < REQUESTS_ROTATE_BYTES) return;
        try {
            const oldest = this.requestsFile + '.' + REQUESTS_KEEP_ROTATIONS;
            if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
            for (let i = REQUESTS_KEEP_ROTATIONS - 1; i >= 1; i--) {
                const from = this.requestsFile + '.' + i;
                if (fs.existsSync(from)) fs.renameSync(from, this.requestsFile + '.' + (i + 1));
            }
            fs.renameSync(this.requestsFile, this.requestsFile + '.1');
            logger.warn(`requests.jsonl 已超过 ${Math.round(REQUESTS_ROTATE_BYTES / 1048576)}MB，完成一次日志轮转喵`);
        } catch (e) {
            console.error('[storage] 流水日志轮转失败:', e.message);
        }
    }

    /** 清理超过保留期的按日统计，防止 stats.json 无限膨胀 */
    _pruneOldDayStats() {
        const byDay = this.lifetime.byDay;
        const keys = Object.keys(byDay);
        if (keys.length <= DAY_STATS_KEEP_DAYS) return;
        const cutoff = this.dayKey(Date.now() - DAY_STATS_KEEP_DAYS * 24 * 3600 * 1000);
        for (const k of keys) {
            if (k < cutoff) delete byDay[k];
        }
    }

    /** 进程退出时强制同步落盘 */
    flushSync() {
        this.flush();
    }

    /** 提供给前端仪表板的数据快照 */
    getSnapshot(activePoolStats) {
        const uptime = Date.now() - this.startedAt;
        const total = this.lifetime.total;
        const avgLatency = total > 0 ? Math.round(this.lifetime.latencySum / total) : 0;

        return {
            uptimeMs: uptime,
            uptimeHuman: Math.floor(uptime / 3600000) + 'h ' + Math.floor((uptime % 3600000) / 60000) + 'm',
            requests: {
                total,
                ok: this.lifetime.ok,
                err: this.lifetime.err,
                stream: this.lifetime.stream,
                withTools: this.lifetime.tools,
                withThinking: this.lifetime.thinking,
                withSearch: this.lifetime.search,
                avgLatencyMs: avgLatency,
                perSec: uptime > 0 ? +(total / (uptime / 1000)).toFixed(3) : 0,
            },
            tokens: this.lifetime.tokens,
            byDay: this.lifetime.byDay,
            byAccount: this.lifetime.byAccount,
            pool: activePoolStats || {},
            recent: this.recent,
            errors: this.errors,
        };
    }
}

module.exports = new PersistentStorage();
