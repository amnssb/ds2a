'use strict';
/**
 * src/account-pool.js — 智能账号调度池与健康熔断器
 * 核心特性：
 * 1. 状态机：HEALTHY (正常), COOLDOWN (冷却), PAUSED (已暂停), AUTH_FAILED (失效熔断), DISABLED (手动停用)
 * 2. 异常智能熔断：遇 40003 invalid token 立刻暂停此账号调度，多账号场景自动 Failover
 * 3. Token 变更自动自愈：修改/更新 Token 时自动解除熔断并恢复 healthy
 * 4. 双向同步：同时维护 data/accounts.json 与根目录 accounts.json，彻底消除配置文件脱节问题
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
        this.dataFile = config.ACCOUNTS_FILE;
        this.rootFile = path.join(config.ROOT_DIR, 'accounts.json');
        this.accounts = [];
        this.cursor = 0;
        this.reload();
    }

    /** 读取原始账号数据，支持双向比对合并 */
    readRaw() {
        let rootList = [];
        let dataList = [];

        try {
            if (fs.existsSync(this.rootFile)) {
                rootList = JSON.parse(fs.readFileSync(this.rootFile, 'utf8'));
                if (!Array.isArray(rootList)) rootList = [];
            }
        } catch (e) {}

        try {
            config.assertNotCDrive(this.dataFile);
            if (fs.existsSync(this.dataFile)) {
                dataList = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
                if (!Array.isArray(dataList)) dataList = [];
            }
        } catch (e) {}

        // 智能合并：以 token / name 为主键合并最新属性
        const mergedMap = new Map();

        // 先填充 dataList
        for (const item of dataList) {
            const key = item.name || item.token;
            if (key) mergedMap.set(key, { ...item });
        }

        // 若 rootList 中存在更新或不同的 token，以 rootList 优先覆盖
        let rootHasNew = false;
        for (const item of rootList) {
            const key = item.name || item.token;
            if (!key) continue;
            if (!mergedMap.has(key)) {
                mergedMap.set(key, { ...item });
                rootHasNew = true;
            } else {
                const existing = mergedMap.get(key);
                // 如果根目录 token 变动了，重置 paused 状态，触发自动恢复
                if (item.token && item.token !== existing.token) {
                    existing.token = item.token;
                    existing.paused = false;
                    existing.lastLoginError = '';
                    rootHasNew = true;
                }
            }
        }

        const merged = [...mergedMap.values()];
        if (merged.length === 0 && rootList.length === 0 && dataList.length === 0) {
            this.writeRaw([]);
            return [];
        }

        if (rootHasNew) {
            this.writeRaw(merged);
        }
        return merged;
    }

    /** 写入磁盘（双向保证 data/accounts.json 和根目录 accounts.json 完全同步） */
    writeRaw(list) {
        try {
            config.assertNotCDrive(this.dataFile);
            const str = JSON.stringify(list, null, 2);

            // 1. 写 data/accounts.json
            const tmpData = this.dataFile + '.tmp';
            fs.writeFileSync(tmpData, str, 'utf8');
            fs.renameSync(tmpData, this.dataFile);

            // 2. 同步根目录 accounts.json
            try {
                config.assertNotCDrive(this.rootFile);
                const tmpRoot = this.rootFile + '.tmp';
                fs.writeFileSync(tmpRoot, str, 'utf8');
                fs.renameSync(tmpRoot, this.rootFile);
            } catch (e) {}

            return true;
        } catch (e) {
            logger.err('写入 accounts.json 失败: ' + e.message);
            return false;
        }
    }

    /** 重新载入账号并合并运行时状态 */
    reload() {
        const rawList = this.readRaw();
        const prevMap = new Map(this.accounts.map(a => [a.name, a]));

        this.accounts = rawList.map((item, i) => {
            const name = item.name || ('acc' + (i + 1));
            const prev = prevMap.get(name);
            const tokenChanged = prev && prev.token !== item.token;

            // 如果 Token 改变了，自动重置故障状态
            const isPaused = tokenChanged ? false : !!item.paused;
            const state = item.disabled ? STATUS.DISABLED : (isPaused ? STATUS.PAUSED : STATUS.HEALTHY);

            return {
                index: i,
                name,
                token: item.token || '',
                email: item.email || '',
                mobile: item.mobile || '',
                areaCode: item.areaCode || '+86',
                password: item.password || '',
                autoLogin: item.autoLogin !== false,
                disabled: !!item.disabled,
                paused: isPaused,
                state: prev ? (tokenChanged ? STATUS.HEALTHY : prev.state) : state,
                disabledUntil: (prev && !tokenChanged) ? prev.disabledUntil : 0,
                failures: (prev && !tokenChanged) ? prev.failures : 0,
                okCount: prev ? prev.okCount : 0,
                errCount: prev ? prev.errCount : 0,
                inflight: 0,
                lastError: tokenChanged ? '' : (prev ? prev.lastError : (item.lastLoginError || '')),
                lastUsedAt: prev ? prev.lastUsedAt : 0,
            };
        });

        this._nameMap = new Map(this.accounts.map(a => [a.name, a]));
        this.cursor = 0;

        const healthyCount = this.getHealthyCount();
        logger.ok(`账号池已加载: 共 ${this.accounts.length} 个账号，其中可用: ${healthyCount} 个`);
        return this.accounts.length;
    }

    _byName(name) {
        return this._nameMap ? this._nameMap.get(name) : this.accounts.find(a => a.name === name);
    }

    getHealthyCount() {
        const now = Date.now();
        return this.accounts.filter(a => !a.disabled && !a.paused && a.state !== STATUS.AUTH_FAILED && a.token && now >= a.disabledUntil).length;
    }

    /** 调度获取一个健康账号进行处理 */
    /**
     * 调度获取一个健康账号进行处理
     * @param {Array<string>} excludeNames - 本次请求中已尝试失败的账号名列表
     */
    acquire(excludeNames = []) {
        const n = this.accounts.length;
        if (!n) {
            throw new Error('账号池为空，请在管理控制台「账号管理」中添加 DeepSeek 账号喵');
        }

        const now = Date.now();
        const excludes = new Set(excludeNames);

        // 1. 过滤已配置 Token 且未被手动禁用的基础账号集合
        const activeAccounts = this.accounts.filter(a => !a.disabled && a.token);
        if (activeAccounts.length === 0) {
            const hasDisabled = this.accounts.some(a => a.disabled);
            if (hasDisabled) {
                throw new Error('所有配置的账号均已被手动停用，请在控制台启用账号调度喵');
            }
            throw new Error('账号池内暂无配置有效 Token 的账号，请在控制台填入 userToken 喵');
        }

        // 2. 检查未被本次 Failover 排除的账号集合
        const nonExcluded = activeAccounts.filter(a => !excludes.has(a.name));
        if (nonExcluded.length === 0) {
            // 本次请求已经将所有账号轮询尝试过一遍
            const pausedFirst = activeAccounts.find(a => a.paused || a.state === STATUS.AUTH_FAILED);
            if (pausedFirst && pausedFirst.lastError) {
                throw new Error(`所有可用账号均尝试失败（原因: ${pausedFirst.lastError}），请在控制台检查并更新 Token 喵`);
            }
            throw new Error(`池中全部 ${activeAccounts.length} 个账号均已在本次请求中尝试过，暂无更多可用账号喵`);
        }

        // 3. 优先从未暂停 (未熔断) 且不在冷却期的账号中筛选候选者
        const healthyCandidates = nonExcluded.filter(a => !a.paused && a.state !== STATUS.AUTH_FAILED && now >= a.disabledUntil);

        if (healthyCandidates.length > 0) {
            // 负载均衡：选择当前在途并发最少 (inflight 最小) 的账号
            healthyCandidates.sort((a, b) => a.inflight - b.inflight);
            const picked = healthyCandidates[0];
            picked.inflight = Math.max(0, (picked.inflight || 0) + 1);
            picked.lastUsedAt = now;
            this.cursor = (picked.index + 1) % n;
            return picked;
        }

        // 4. 若所有未排除账号均处于暂停/熔断状态
        const pausedList = nonExcluded.filter(a => a.paused || a.state === STATUS.AUTH_FAILED);
        if (pausedList.length === nonExcluded.length) {
            const firstErr = pausedList[0].lastError || 'Token 已失效或认证未通过';
            throw new Error(`可用账号已熔断暂停（原因: ${firstErr}），请在控制台「账号管理」中更新有效 Token 喵`);
        }

        // 5. 若未排除账号都在冷却期中，挑一个冷却时间最快到期的账号进行尝试（借鉴原版容灾自愈设计）
        const cooldownList = nonExcluded.filter(a => now < a.disabledUntil);
        if (cooldownList.length > 0) {
            cooldownList.sort((a, b) => a.disabledUntil - b.disabledUntil);
            const best = cooldownList[0];
            const waitSec = Math.max(0, Math.round((best.disabledUntil - now) / 1000));
            // 如果冷却期超过 10 秒则提示稍后，如果在 10 秒以内则直接借用它尝试自愈
            if (waitSec > 10) {
                throw new Error(`账号正在冷却中（最快需等待 ${waitSec} 秒），请稍后重试喵`);
            }
            best.inflight = Math.max(0, (best.inflight || 0) + 1);
            best.lastUsedAt = now;
            return best;
        }

        // 6. 兜底选择在途请求最少的账号，绝不轻易无端拒绝请求
        nonExcluded.sort((a, b) => a.inflight - b.inflight);
        const fallback = nonExcluded[0];
        fallback.inflight = Math.max(0, (fallback.inflight || 0) + 1);
        fallback.lastUsedAt = now;
        return fallback;
    }

    release(account) {
        if (!account) return;
        const acc = this._byName(account.name);
        if (acc) {
            acc.inflight = Math.max(0, (acc.inflight || 1) - 1);
        }
    }

    markOk(account) {
        if (!account) return;
        const acc = this._byName(account.name);
        if (!acc) return;
        acc.failures = 0;
        acc.disabledUntil = 0;
        acc.state = STATUS.HEALTHY;
        acc.lastError = '';
        acc.okCount++;
    }

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
            acc.state = STATUS.AUTH_FAILED;
            acc.paused = true;
            logger.err(`🚨 账号 ${acc.name} 认证失效 [bizCode=${bizCode}]，已立即熔断并暂停调度！错误: ${errMsg}`);
            this.persistAccountState(acc.index, { paused: true, lastLoginError: errMsg });

            // 若配置了账密且开启 autoLogin，尝试自愈重登
            if (acc.autoLogin && acc.password && (acc.email || acc.mobile)) {
                this.triggerAutoRelogin(acc).catch(() => {});
            }
            return;
        }

        // 普通退避冷却
        const shift = Math.min(acc.failures - 1, 5);
        const cooldownMs = Math.min(config.COOLDOWN_BASE_MS * Math.pow(2, shift), config.COOLDOWN_MAX_MS);
        acc.disabledUntil = Date.now() + cooldownMs;
        acc.state = STATUS.COOLDOWN;
        logger.warn(`账号 ${acc.name} 调用失败 ${acc.failures} 次，冷却 ${Math.round(cooldownMs / 1000)}s: ${errMsg}`);

        if (acc.failures >= 3) {
            acc.state = STATUS.PAUSED;
            acc.paused = true;
            logger.err(`账号 ${acc.name} 连续失败 3 次，已自动暂停调度！`);
            this.persistAccountState(acc.index, { paused: true, lastLoginError: '连续多次失败，已自动暂停' });
        }
    }

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
            logger.err(`账号 ${account.name} 自动重登异常: ${e.message}`);
            return false;
        }
    }

    persistAccountState(index, patch) {
        const raw = this.readRaw();
        if (index >= 0 && index < raw.length) {
            Object.assign(raw[index], patch);
            this.writeRaw(raw);
        }
    }

    addAccount(accData) {
        const raw = this.readRaw();
        let token = String(accData.token || '').trim();
        if (token.startsWith('{')) {
            try { token = JSON.parse(token).value || token; } catch (e) {}
        }
        const name = String(accData.name || ('acc' + (raw.length + 1))).trim();

        const item = {
            name,
            token,
            email: String(accData.email || '').trim(),
            mobile: String(accData.mobile || '').trim(),
            areaCode: String(accData.areaCode || '+86').trim(),
            password: String(accData.password || '').trim(),
            autoLogin: accData.autoLogin !== false,
            disabled: !!accData.disabled,
            paused: false,
            lastLoginError: '',
            lastLoginAt: '',
        };

        raw.push(item);
        this.writeRaw(raw);
        this.reload();
        return { ok: true, account: item };
    }

    updateAccount(index, patch) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return { ok: false, error: '账号不存在' };

        const target = raw[index];
        if (patch.token !== undefined) {
            let token = String(patch.token).trim();
            if (token.startsWith('{')) {
                try { token = JSON.parse(token).value || token; } catch (e) {}
            }
            if (token && token !== target.token) {
                target.token = token;
                // 更新 Token 时自动解除暂停并清除错误
                target.paused = false;
                target.lastLoginError = '';
            }
        }
        if (patch.name) target.name = String(patch.name).trim();
        if (patch.email !== undefined) target.email = String(patch.email).trim();
        if (patch.mobile !== undefined) target.mobile = String(patch.mobile).trim();
        if (patch.areaCode !== undefined) target.areaCode = String(patch.areaCode).trim();
        if (patch.password !== undefined) target.password = String(patch.password).trim();
        if (patch.autoLogin !== undefined) target.autoLogin = !!patch.autoLogin;
        if (patch.disabled !== undefined) target.disabled = !!patch.disabled;
        if (patch.paused !== undefined) target.paused = !!patch.paused;
        if (patch.lastLoginError !== undefined) target.lastLoginError = String(patch.lastLoginError);
        if (patch.lastLoginAt !== undefined) target.lastLoginAt = String(patch.lastLoginAt);

        this.writeRaw(raw);
        this.reload();
        return { ok: true, account: target };
    }

    removeAccount(index) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return { ok: false, error: '账号不存在' };
        raw.splice(index, 1);
        this.writeRaw(raw);
        this.reload();
        return { ok: true };
    }

    pauseAccount(index) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return false;
        raw[index].paused = true;
        this.writeRaw(raw);
        this.reload();
        return true;
    }

    resumeAccount(index) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return false;
        raw[index].paused = false;
        raw[index].lastLoginError = '';
        this.writeRaw(raw);
        this.reload();
        return true;
    }

    snapshot() {
        const now = Date.now();
        return this.accounts.map(a => ({
            name: a.name,
            state: a.state,
            healthy: a.state === STATUS.HEALTHY && now >= a.disabledUntil,
            cooldownSec: Math.max(0, Math.round((a.disabledUntil - now) / 1000)),
            failures: a.failures,
            ok: a.okCount,
            err: a.errCount,
            inflight: a.inflight,
            lastError: a.lastError,
        }));
    }
}

module.exports = new AccountPool();
