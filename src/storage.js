'use strict';
/**
 * src/storage.js — 运行时统计与请求日志持久化模块
 * 解决“重启后日志与 Token 记录丢失”的问题，落盘全部写入 D 盘 data/ 目录
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

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

        // 2. 加载最近历史请求
        if (fs.existsSync(this.requestsFile)) {
            try {
                const content = fs.readFileSync(this.requestsFile, 'utf8');
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

    /** 异步落盘 */
    flush() {
        if (!this._writeBuffer.length) return;
        const chunk = this._writeBuffer.join('\n') + '\n';
        this._writeBuffer = [];

        try {
            config.assertNotCDrive(this.requestsFile);
            fs.appendFileSync(this.requestsFile, chunk, 'utf8');
        } catch (e) {
            console.error('[storage] 追加日志失败:', e.message);
        }

        try {
            config.assertNotCDrive(this.statsFile);
            const tmp = this.statsFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.lifetime, null, 2), 'utf8');
            fs.renameSync(tmp, this.statsFile);
        } catch (e) {
            console.error('[storage] 保存聚合统计失败:', e.message);
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
