'use strict';
/**
 * src/account-pool.js — 智能账号调度池与健康熔断器
 * 核心特性：
 * 1. 状态机：HEALTHY (正常), COOLDOWN (冷却), PAUSED (已暂停), AUTH_FAILED (失效熔断), DISABLED (手动停用)
 * 2. 异常自动暂停调度：遇到 40003 (invalid token) / 401 立刻移出调度队列，停止重试打扰官方风控
 * 3. 多账号无缝故障转移 (Failover)：某账号故障自动无感切换至下一个健康账号
 * 4. 账号自愈机制：配置了账号密码的账号，后台异步尝试自动重登换新 Token，成功自动恢复调度
 * 5. 手动干预支持：支持控制台一键测试、手动恢复调度、手动暂停调度
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const STATUS = {
    HEALTHY: 'healthy',
    COOLDOWN: 'cooldown',
    PAUSED: 'paused',
    AUTH_FAILED: 'auth_failed',
    DISABLED: 'disabled',
};

class AccountPool {
    constructor() {
        this.file = config.ACCOUNTS_FILE;
        this.accounts = [];
        this.cursor = 0;
        this.reload();
    }

    readRaw() {
        try {
            config.assertNotCDrive(this.file);
            if (!fs.existsSync(this.file)) {
                fs.writeFileSync(this.file, '[]', 'utf8');
                return [];
            }
            return JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch (e) {
            logger.err('读取 accounts.json 失败: ' + e.message);
            return [];
        }
    }

    writeRaw(list) {
        try {
            config.assertNotCDrive(this.file);
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
            fs.renameSync(tmp, this.file);
            return true;
        } catch (e) {
            logger.err('写入 accounts.json 失败: ' + e.message);
            return false;
        }
    }

    /** 重新从磁盘载入账号并合并运行时状态 */
    reload() {
        const rawList = this.readRaw();
        const prevMap = new Map(this.accounts.map(a => [a.name, a]));

        this.accounts = rawList.map((item, index) => {
            const name = item.name || ('acc' + (index + 1));
            const prev = prevMap.get(name);

            // 继承或初始化运行时状态
            let state = STATUS.HEALTHY;
            if (item.disabled) state = STATUS.DISABLED;
            else if (item.paused) state = STATUS.PAUSED;
            else if (prev && prev.state) state = prev.state;

            return {
                index,
                name,
                token: String(item.token || '').trim(),
                email: String(item.email || '').trim(),
                mobile: String(item.mobile || '').trim(),
                areaCode: String(item.areaCode || '+86'),
                password: String(item.password || ''),
                autoLogin: item.autoLogin !== false,
                disabled: !!item.disabled,
                paused: !!item.paused,
                state: state,
                disabledUntil: prev ? prev.disabledUntil : 0,
                failures: prev ? prev.failures : 0,
                okCount: prev ? prev.okCount : 0,
                errCount: prev ? prev.errCount : 0,
                lastError: item.lastLoginError || (prev ? prev.lastError : ''),
                lastUsedAt: prev ? prev.lastUsedAt : 0,
                inflight: 0, // 当前并发请求数
            };
        });

        // 重建 O(1) 查找索引
        this._nameMap = new Map(this.accounts.map(a => [a.name, a]));

        logger.ok(`账号池已加载: 共 ${this.accounts.length} 个账号，其中可用: ${this.getHealthyCount()} 个`);
        return this.accounts.length;
    }

    /** O(1) 按名字查找账号（内部使用）*/
    _byName(name) {
        return this._nameMap ? this._nameMap.get(name) : this.accounts.find(a => a.name === name);
    }

    getHealthyCount() {
        const now = Date.now();
        return this.accounts.filter(a => !a.disabled && !a.paused && a.state !== STATUS.AUTH_FAILED && a.token && now >= a.disabledUntil).length;
    }

    /**
     * 智能获取一个可用账号进行调度
     * @param {Array<string>} excludeNames - 本次请求中已尝试失败的账号名列表（用于 Failover）
     */
    acquire(excludeNames = []) {
        const n = this.accounts.length;
        if (!n) {
            throw new Error('账号池为空，请在管理面板添加 DeepSeek 账号喵');
        }

        const now = Date.now();
        const excludes = new Set(excludeNames);

        // 1. 优先筛选：状态健康、未被本次排除、不在冷却期、未超过单账号并发上限
        const candidates = [];
        for (let i = 0; i < n; i++) {
            const acc = this.accounts[(this.cursor + i) % n];
            if (excludes.has(acc.name)) continue;
            if (acc.disabled) continue;
            if (acc.paused || acc.state === STATUS.AUTH_FAILED) continue;
            if (!acc.token) continue;

            if (now >= acc.disabledUntil) {
                // 检查并发负载
                if (acc.inflight < config.MAX_CONCURRENT_PER_ACCOUNT) {
                    candidates.push(acc);
                }
            }
        }

        if (candidates.length > 0) {
            // 选择并发负载最小的账号（负载均衡）
            candidates.sort((a, b) => a.inflight - b.inflight);
            const picked = candidates[0];
            picked.inflight++;
            picked.lastUsedAt = now;
            this.cursor = (picked.index + 1) % n;
            return picked;
        }

        // 2. 如果全都不可用，检查具体原因
        const pausedCount = this.accounts.filter(a => a.paused || a.state === STATUS.AUTH_FAILED).length;
        const cooldownAccounts = this.accounts.filter(a => !a.disabled && !a.paused && now < a.disabledUntil);

        if (cooldownAccounts.length > 0) {
            const minWait = Math.min(...cooldownAccounts.map(a => Math.max(0, Math.round((a.disabledUntil - now) / 1000))));
            throw new Error(`所有可用账号均在冷却中（最快需等待 ${minWait} 秒），请稍后重试喵`);
        }

        if (pausedCount === n) {
            const firstErr = this.accounts[0].lastError || 'Token 已失效';
            throw new Error(`全部 ${n} 个账号均异常并已暂停调度（原因: ${firstErr}），请在面板检查并更新 Token 喵`);
        }

        throw new Error('暂无空闲可用账号（均在忙或已达并发上限），请稍后重试喵');
    }

    /** 释放并发计数 */
    release(account) {
        if (!account) return;
        const acc = this._byName(account.name);
        if (acc && acc.inflight > 0) acc.inflight--;
    }

    /** 标记请求成功 */
    markOk(account) {
        if (!account) return;
        const acc = this._byName(account.name);
        if (!acc) return;
        acc.failures = 0;
        acc.disabledUntil = 0;
        acc.state = STATUS.HEALTHY;
        acc.okCount++;
    }

    /**
     * 标记请求失败并执行熔断策略
     * @param {object} account 
     * @param {Error|string} error 
     * @param {number} statusCode 
     * @param {number} bizCode 
     */
    markFail(account, error, statusCode = 500, bizCode = null) {
        if (!account) return;
        const acc = this._byName(account.name);
        if (!acc) return;

        acc.errCount++;
        acc.failures++;
        const errMsg = error ? (error.message || String(error)) : '未知错误';
        acc.lastError = errMsg;

        const isAuthError = bizCode === 40003 ||
            statusCode === 401 ||
            /invalid token|token expired|40003|鉴权失败|未登录/i.test(errMsg);

        if (isAuthError) {
            // 【核心需求】：账号异常立刻暂停调度！
            acc.state = STATUS.AUTH_FAILED;
            acc.paused = true;
            logger.err(`🚨 账号 ${acc.name} 认证失效 [bizCode=${bizCode}]，已立即熔断并暂停调度！错误: ${errMsg}`);

            // 持久化保存异常状态
            this.persistAccountState(acc.index, { paused: true, lastLoginError: errMsg });

            // 触发自动重登尝试（若开启 autoLogin 且有凭证）
            if (acc.autoLogin && acc.password && (acc.email || acc.mobile)) {
                this.triggerAutoRelogin(acc).catch(() => {});
            }
            return;
        }

        // 普通网络或限流错误（例如 429 或 5xx），进入退避冷却
        const shift = Math.min(acc.failures - 1, 5);
        const cooldownMs = Math.min(config.COOLDOWN_BASE_MS * Math.pow(2, shift), config.COOLDOWN_MAX_MS);
        acc.disabledUntil = Date.now() + cooldownMs;
        acc.state = STATUS.COOLDOWN;

        logger.warn(`账号 ${acc.name} 调用失败 ${acc.failures} 次，冷却 ${Math.round(cooldownMs / 1000)}s: ${errMsg}`);

        // 连续失败次数达到熔断阈值（>=3 次连续失败）自动暂停
        if (acc.failures >= 3) {
            acc.state = STATUS.PAUSED;
            acc.paused = true;
            logger.err(`账号 ${acc.name} 连续失败 3 次，已自动暂停调度！`);
            this.persistAccountState(acc.index, { paused: true, lastLoginError: '连续多次失败，已自动暂停' });
        }
    }

    /** 异步自动重登尝试 */
    async triggerAutoRelogin(account) {
        logger.info(`正在为账号 ${account.name} 尝试自动重新登录刷新 Token...`);
        try {
            const dsLogin = require('../ds-login');
            const r = await dsLogin.loginAccount(account);
            if (r.ok && r.token) {
                logger.ok(`🎉 账号 ${account.name} 自动重新登录成功，新 Token 已更新，恢复调度！`);
                this.updateAccount(account.index, {
                    token: r.token,
                    paused: false,
                    lastLoginAt: new Date().toISOString(),
                    lastLoginError: '',
                });
                return true;
            } else {
                logger.err(`账号 ${account.name} 自动重登未成功: ${r.error || '未知原因'}`);
                return false;
            }
        } catch (e) {
            logger.err(`账号 ${account.name} 自动登录执行异常: ${e.message}`);
            return false;
        }
    }

    /** 手动恢复调度 */
    resumeAccount(index) {
        if (index < 0 || index >= this.accounts.length) return false;
        const acc = this.accounts[index];
        acc.paused = false;
        acc.state = STATUS.HEALTHY;
        acc.failures = 0;
        acc.disabledUntil = 0;
        acc.lastError = '';
        this.persistAccountState(index, { paused: false, lastLoginError: '' });
        logger.ok(`账号 ${acc.name} 已手动恢复调度`);
        return true;
    }

    /** 手动暂停调度 */
    pauseAccount(index) {
        if (index < 0 || index >= this.accounts.length) return false;
        const acc = this.accounts[index];
        acc.paused = true;
        acc.state = STATUS.PAUSED;
        this.persistAccountState(index, { paused: true, lastLoginError: '管理员手动暂停' });
        logger.warn(`账号 ${acc.name} 已手动暂停调度`);
        return true;
    }

    /** 持久化部分状态到 accounts.json */
    persistAccountState(index, patch) {
        const raw = this.readRaw();
        if (raw[index]) {
            Object.assign(raw[index], patch);
            this.writeRaw(raw);
        }
    }

    /** 更新账号配置 */
    updateAccount(index, patch) {
        const raw = this.readRaw();
        if (!raw[index]) return { ok: false, error: '账号不存在' };

        const item = raw[index];
        if (patch.name) item.name = String(patch.name).trim();
        if (patch.token !== undefined) item.token = String(patch.token).trim();
        if (patch.email !== undefined) item.email = String(patch.email).trim();
        if (patch.mobile !== undefined) item.mobile = String(patch.mobile).trim();
        if (patch.areaCode !== undefined) item.areaCode = String(patch.areaCode).trim();
        if (patch.password) item.password = String(patch.password);
        if (patch.disabled !== undefined) item.disabled = !!patch.disabled;
        if (patch.paused !== undefined) item.paused = !!patch.paused;
        if (patch.autoLogin !== undefined) item.autoLogin = !!patch.autoLogin;
        if (patch.lastLoginAt) item.lastLoginAt = patch.lastLoginAt;
        if (patch.lastLoginError !== undefined) item.lastLoginError = patch.lastLoginError;

        this.writeRaw(raw);
        this.reload();
        return { ok: true, account: item };
    }

    /** 新增账号 */
    addAccount(acc) {
        const raw = this.readRaw();
        const name = String(acc.name || ('acc' + (raw.length + 1))).trim();
        if (raw.some(a => (a.name || '') === name)) {
            return { ok: false, error: '账号名已存在: ' + name };
        }

        const item = {
            name,
            token: String(acc.token || '').trim(),
            email: String(acc.email || '').trim(),
            mobile: String(acc.mobile || '').trim(),
            areaCode: String(acc.areaCode || '+86'),
            password: String(acc.password || ''),
            autoLogin: acc.autoLogin !== false,
            disabled: !!acc.disabled,
            paused: false,
            lastLoginAt: '',
            lastLoginError: '',
        };

        raw.push(item);
        this.writeRaw(raw);
        this.reload();
        return { ok: true, account: item, index: raw.length - 1 };
    }

    /** 删除账号 */
    removeAccount(index) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return { ok: false, error: '账号不存在' };
        raw.splice(index, 1);
        this.writeRaw(raw);
        this.reload();
        return { ok: true };
    }

    /** 导出控制台数据视图 */
    snapshot() {
        const now = Date.now();
        return this.accounts.map(a => {
            let displayState = a.state;
            if (a.disabled) displayState = 'disabled';
            else if (a.paused) displayState = 'paused';
            else if (now < a.disabledUntil) displayState = 'cooldown';

            return {
                index: a.index,
                name: a.name,
                email: a.email,
                mobile: a.mobile,
                areaCode: a.areaCode,
                token: a.token ? (a.token.slice(0, 6) + '…' + a.token.slice(-4)) : '',
                hasToken: !!a.token,
                autoLogin: a.autoLogin,
                hasPassword: !!a.password,
                state: displayState,
                healthy: displayState === 'healthy',
                cooldownSec: Math.max(0, Math.round((a.disabledUntil - now) / 1000)),
                failures: a.failures,
                ok: a.okCount,
                err: a.errCount,
                inflight: a.inflight,
                lastError: a.lastError,
                lastUsedAt: a.lastUsedAt,
            };
        });
    }
}

module.exports = new AccountPool();
