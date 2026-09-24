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
const { EventEmitter } = require('events');
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

        // rootList 与 dataList 同 key 时：token 变了以 root 为准并解熔断；其余字段按「非空覆盖」同步
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
                // 同步其余配置字段（password/email 等），避免双文件脱节
                for (const f of ['email', 'mobile', 'areaCode', 'password', 'autoLogin', 'disabled', 'name', 'deviceId', 'proxy']) {
                    if (item[f] !== undefined && item[f] !== null && item[f] !== '' && item[f] !== existing[f]) {
                        existing[f] = item[f];
                        rootHasNew = true;
                    }
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
        const str = JSON.stringify(list, null, 2);
        let okData = false;
        let okRoot = false;

        // 1. 写 data/accounts.json（失败不阻断根目录同步）
        try {
            config.assertNotCDrive(this.dataFile);
            const dir = path.dirname(this.dataFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmpData = this.dataFile + '.tmp';
            fs.writeFileSync(tmpData, str, 'utf8');
            fs.renameSync(tmpData, this.dataFile);
            okData = true;
        } catch (e) {
            logger.err('写入 data/accounts.json 失败: ' + e.message);
        }

        // 2. 同步根目录 accounts.json
        try {
            config.assertNotCDrive(this.rootFile);
            const tmpRoot = this.rootFile + '.tmp';
            fs.writeFileSync(tmpRoot, str, 'utf8');
            fs.renameSync(tmpRoot, this.rootFile);
            okRoot = true;
        } catch (e) {
            logger.err('写入根目录 accounts.json 失败: ' + e.message);
        }

        if (!okData && !okRoot) {
            logger.err('accounts.json 双路写入均失败，内存态可能在重启后丢失');
            return false;
        }
        return true;
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
            let state;
            if (tokenChanged) state = STATUS.HEALTHY;
            else if (item.disabled) state = STATUS.DISABLED;
            else if (isPaused) state = STATUS.PAUSED;
            else if (prev && prev.state !== STATUS.DISABLED && prev.state !== STATUS.PAUSED) state = prev.state;
            else state = STATUS.HEALTHY;

            return {
                index: i,
                name,
                token: item.token || '',
                email: item.email || '',
                deviceId: item.deviceId || '',
                mobile: item.mobile || '',
                areaCode: item.areaCode || '+86',
                password: item.password || '',
                autoLogin: item.autoLogin !== false,
                proxy: item.proxy || '',
                disabled: !!item.disabled,
                paused: isPaused,
                state,
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

    /**
     * 调度获取一个健康账号进行处理
     * @param {Array<string>} excludeNames - 本次请求中已尝试失败的账号名列表
     * @param {string|null} preferName - 优先粘滞的会话原账号（仍健康时复用，避免 sid/token 错配）
     */
    acquire(excludeNames = [], preferName = null) {
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

        // 3. 优先从未暂停 (未熔断) 且不在冷却期、且未达单账号并发上限的账号中筛选候选者
        const maxPer = Math.max(1, config.MAX_CONCURRENT_PER_ACCOUNT || 5);
        const healthyCandidates = nonExcluded.filter(a =>
            !a.paused &&
            a.state !== STATUS.AUTH_FAILED &&
            now >= a.disabledUntil &&
            (a.inflight || 0) < maxPer
        );

        if (healthyCandidates.length > 0) {
            // 会话粘滞：原账号仍健康则优先复用（sid 属于该账号 token）
            if (preferName) {
                const pref = healthyCandidates.find(a => a.name === preferName);
                if (pref) {
                    pref.inflight = Math.max(0, (pref.inflight || 0) + 1);
                    pref.lastUsedAt = now;
                    this.cursor = (pref.index + 1) % n;
                    return pref;
                }
            }

            // 负载均衡：在途并发最少优先；同并发下最久未调用 (LRU) 优先，保证多账号完全均匀轮流调度
            healthyCandidates.sort((a, b) => {
                if (a.inflight !== b.inflight) return a.inflight - b.inflight;
                return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
            });
            const picked = healthyCandidates[0];
            picked.inflight = Math.max(0, (picked.inflight || 0) + 1);
            picked.lastUsedAt = now;
            return picked;
        }

        // 3.1 全部健康账号都在途满载时，允许轻微超发而不是直接失败
        const atCap = nonExcluded.filter(a => !a.paused && a.state !== STATUS.AUTH_FAILED && now >= a.disabledUntil);
        if (atCap.length > 0) {
            if (preferName) {
                const pref = atCap.find(a => a.name === preferName);
                if (pref) {
                    pref.inflight = Math.max(0, (pref.inflight || 0) + 1);
                    pref.lastUsedAt = now;
                    return pref;
                }
            }
            atCap.sort((a, b) => {
                if (a.inflight !== b.inflight) return a.inflight - b.inflight;
                return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
            });
            const picked = atCap[0];
            picked.inflight = Math.max(0, (picked.inflight || 0) + 1);
            picked.lastUsedAt = now;
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

        // 网络抖动 / 空响应 / 停滞：短暂轻冷却，不计入熔断计数，避免单账号误暂停
        const isTransient = /上游网络异常|空响应|连接中断|停滞超时|fetch failed|AbortError|UND_ERR|ECONNRESET|ETIMEDOUT/i.test(errMsg)
            || statusCode === 502 || statusCode === 504;
        if (isTransient) {
            const lightMs = 3000;
            acc.disabledUntil = Math.max(acc.disabledUntil, Date.now() + lightMs);
            if (acc.state !== STATUS.PAUSED && acc.state !== STATUS.AUTH_FAILED) {
                acc.state = STATUS.COOLDOWN;
            }
            logger.warn(`账号 ${acc.name} 瞬时故障，轻冷却 ${Math.round(lightMs / 1000)}s（不计熔断）: ${errMsg}`);
            return;
        }

        // 普通退避冷却
        const shift = Math.min(acc.failures - 1, 5);
        const cooldownMs = Math.min(config.COOLDOWN_BASE_MS * Math.pow(2, shift), config.COOLDOWN_MAX_MS);
        acc.disabledUntil = Date.now() + cooldownMs;
        acc.state = STATUS.COOLDOWN;
        logger.warn(`账号 ${acc.name} 调用失败 ${acc.failures} 次，冷却 ${Math.round(cooldownMs / 1000)}s: ${errMsg}`);

        const failLimit = Math.max(1, config.CIRCUIT_BREAKER_FAIL_LIMIT || 3);
        if (acc.failures >= failLimit) {
            acc.state = STATUS.PAUSED;
            acc.paused = true;
            logger.err(`账号 ${acc.name} 连续失败 ${failLimit} 次，已自动暂停调度！`);
            this.persistAccountState(acc.index, { paused: true, lastLoginError: '连续多次失败，已自动暂停' });
        }
    }

    async triggerAutoRelogin(account) {
        logger.info(`正在为账号 ${account.name} 尝试自动重新登录刷新 Token...`);
        try {
            const dsLogin = require('../ds-login');
            const opts = { ...account };
            if (account.deviceId) opts.deviceId = account.deviceId;
            const r = await dsLogin.loginAccount(opts);
            if (r.ok && r.token) {
                logger.ok(`🎉 账号 ${account.name} 自动重新登录成功，新 Token 已更新，恢复调度！`);
                const patch = {
                    token: r.token,
                    paused: false,
                    lastLoginAt: new Date().toISOString(),
                    lastLoginError: '',
                };
                if (r.deviceId) patch.deviceId = r.deviceId;
                this.updateAccount(account.index, patch);
                return true;
            } else {
                logger.err(`账号 ${account.name} 自动重登未成功: ${r.error || '未知原因'}`);
                if (r.deviceId) this.updateAccount(account.index, { deviceId: r.deviceId });
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
            try {
                const o = JSON.parse(token);
                const v = o && (o.value ?? o.token ?? o.user_token);
                token = (v && String(v).trim() && String(v) !== 'null') ? String(v).trim() : '';
            } catch (e) { token = ''; }
        }
        if (token === 'null' || token === 'undefined') token = '';
        const name = String(accData.name || ('acc' + (raw.length + 1))).trim();

        const item = {
            name,
            token,
            email: String(accData.email || '').trim(),
            mobile: String(accData.mobile || '').trim(),
            areaCode: String(accData.areaCode || '+86').trim(),
            password: String(accData.password || '').trim(),
            autoLogin: accData.autoLogin !== false,
            proxy: String(accData.proxy || '').trim(),
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
                try {
                    const o = JSON.parse(token);
                    const v = o && (o.value ?? o.token ?? o.user_token);
                    token = (v && String(v).trim() && String(v) !== 'null') ? String(v).trim() : '';
                } catch (e) { token = ''; }
            }
            if (token === 'null' || token === 'undefined') token = '';
            if (token && token !== target.token) {
                target.token = token;
                // 更新 Token 时自动解除暂停并清除错误
                target.paused = false;
                target.lastLoginError = '';
            } else if (!token && patch.token === '') {
                target.token = '';
            }
        }
        if (patch.name) target.name = String(patch.name).trim();
        if (patch.email !== undefined) target.email = String(patch.email).trim();
        if (patch.mobile !== undefined) target.mobile = String(patch.mobile).trim();
        if (patch.areaCode !== undefined) target.areaCode = String(patch.areaCode).trim();
        if (patch.password !== undefined) target.password = String(patch.password).trim();
        if (patch.deviceId !== undefined) target.deviceId = String(patch.deviceId).trim();
        if (patch.proxy !== undefined) target.proxy = String(patch.proxy).trim();
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

    /** 供本地 Studio 下发的状态快照（服务端权威：disabled/paused/运行态） */
    statusSnapshot() {
        const now = Date.now();
        const poolByName = new Map(this.accounts.map(a => [a.name, a]));
        return this.readRaw().map((a, i) => {
            const name = a.name || ('acc' + (i + 1));
            const p = poolByName.get(name) || this.accounts[i];
            return {
                index: i,
                name,
                disabled: !!a.disabled,
                paused: !!(p ? p.paused : a.paused),
                state: p ? p.state : (a.disabled ? 'disabled' : (a.paused ? 'paused' : 'healthy')),
                healthy: p ? (p.state === STATUS.HEALTHY && now >= p.disabledUntil) : !a.disabled,
                hasToken: !!a.token,
                hasPassword: !!a.password,
                email: a.email || '',
                mobile: a.mobile || '',
                failures: p ? p.failures : 0,
                ok: p ? p.okCount : 0,
                err: p ? p.errCount : 0,
                inflight: p ? p.inflight : 0,
                cooldownSec: p ? Math.max(0, Math.round((p.disabledUntil - now) / 1000)) : 0,
                lastError: p ? p.lastError : (a.lastLoginError || ''),
                lastLoginAt: a.lastLoginAt || '',
                lastUsedAt: p ? p.lastUsedAt : 0,
                deviceId: a.deviceId || '',
                proxy: a.proxy || '',
            };
        });
    }

    /**
     * 本地 Studio 批量上行：只同步身份/账密/Token/deviceId。
     * disabled 是服务端权威字段，上行默认不覆盖（除非 item.forceDisabled）。
     */
    syncFromClient(items) {
        if (!Array.isArray(items)) return { ok: false, error: 'accounts 必须是数组' };
        const raw = this.readRaw();
        const byName = new Map(raw.map((a, i) => [String(a.name || ''), i]));
        let created = 0;
        let updated = 0;

        const cleanToken = (t) => {
            let token = String(t || '').trim();
            if (token.startsWith('{')) {
                try {
                    const o = JSON.parse(token);
                    const v = o && (o.value ?? o.token ?? o.user_token);
                    token = (v && String(v).trim() && String(v) !== 'null') ? String(v).trim() : '';
                } catch (e) { token = ''; }
            }
            if (token === 'null' || token === 'undefined') token = '';
            return token;
        };

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const name = String(item.name || '').trim();
            if (!name) continue;
            const token = cleanToken(item.token);
            const email = item.email !== undefined ? String(item.email || '').trim() : null;
            const mobile = item.mobile !== undefined ? String(item.mobile || '').trim() : null;
            const areaCode = item.areaCode !== undefined ? String(item.areaCode || '').trim() : null;
            const password = item.password !== undefined ? String(item.password || '').trim() : null;
            const deviceId = item.deviceId !== undefined ? String(item.deviceId || '').trim() : null;
            const proxy = item.proxy !== undefined ? String(item.proxy || '').trim() : null;
            const lastLoginAt = item.lastLoginAt ? String(item.lastLoginAt) : null;
            const autoLogin = item.autoLogin !== undefined ? !!item.autoLogin : null;

            if (byName.has(name)) {
                const idx = byName.get(name);
                const t = raw[idx];
                let dirty = false;
                if (token && token !== t.token) {
                    t.token = token;
                    t.paused = false;
                    t.lastLoginError = '';
                    dirty = true;
                }
                if (email !== null && email && email !== t.email) { t.email = email; dirty = true; }
                if (mobile !== null && mobile && mobile !== t.mobile) { t.mobile = mobile; dirty = true; }
                if (areaCode !== null && areaCode && areaCode !== t.areaCode) { t.areaCode = areaCode; dirty = true; }
                if (password !== null && password && password !== t.password) { t.password = password; dirty = true; }
                if (deviceId !== null && deviceId && deviceId !== t.deviceId) { t.deviceId = deviceId; dirty = true; }
                if (proxy !== null && proxy !== t.proxy) { t.proxy = proxy; dirty = true; }
                if (lastLoginAt && lastLoginAt !== t.lastLoginAt) { t.lastLoginAt = lastLoginAt; dirty = true; }
                if (autoLogin !== null && autoLogin !== t.autoLogin) { t.autoLogin = autoLogin; dirty = true; }
                // 仅显式 forceDisabled 才允许客户端改服务端禁用态
                if (item.forceDisabled === true && !t.disabled) { t.disabled = true; dirty = true; }
                if (item.forceDisabled === false && t.disabled) { t.disabled = false; dirty = true; }
                if (dirty) updated++;
            } else {
                raw.push({
                    name,
                    token,
                    email: email || '',
                    mobile: mobile || '',
                    areaCode: areaCode || '+86',
                    password: password || '',
                    autoLogin: autoLogin !== false,
                    disabled: item.forceDisabled === true,
                    paused: false,
                    lastLoginError: '',
                    lastLoginAt: lastLoginAt || '',
                    deviceId: deviceId || '',
                    proxy: proxy || '',
                });
                byName.set(name, raw.length - 1);
                created++;
            }
        }

        if (created || updated) this.writeRaw(raw);
        this.reload();
        this.emitChange('sync');
        return { ok: true, created, updated, total: raw.length, status: this.statusSnapshot() };
    }

    setDisabled(index, disabled) {
        const raw = this.readRaw();
        if (index < 0 || index >= raw.length) return { ok: false, error: '账号不存在' };
        raw[index].disabled = !!disabled;
        if (disabled) raw[index].paused = true;
        else raw[index].paused = false;
        this.writeRaw(raw);
        this.reload();
        this.emitChange(disabled ? 'disable' : 'enable');
        return { ok: true, account: { name: raw[index].name, disabled: !!disabled } };
    }
}

// 状态变更事件（供 SSE 下发给本地 Studio）
const bus = new EventEmitter();
bus.setMaxListeners(200);
const pool = new AccountPool();
const origWrite = pool.writeRaw.bind(pool);
pool.writeRaw = function (list) {
    const r = origWrite(list);
    if (r) this.emitChange('write');
    return r;
};
pool.emitChange = function (reason) {
    try {
        bus.emit('change', { reason, at: Date.now(), status: pool.statusSnapshot() });
    } catch (e) {}
};
pool.on = bus.on.bind(bus);
pool.off = bus.off.bind(bus);
pool.once = bus.once.bind(bus);

module.exports = pool;
