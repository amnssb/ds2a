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

function isDummyAccount(a) {
    if (!a || typeof a !== 'object') return true;
    const name = String(a.name || '').trim();
    const token = String(a.token || '').trim();
    const email = String(a.email || '').trim();
    const mobile = String(a.mobile || '').trim();
    const password = String(a.password || '').trim();

    if (name === 'acc1' && (email === 'your@email.com' || token === 'ZMGZOj1u3WLmpqXxb5PbeB9uE5xS0TT2C6qhq0Sp37i9IZ44DyIHTKyBH7bQkEJP' || token === 'YOUR_DEEPSEEK_USER_TOKEN_HERE')) return true;
    if (name === 'acc2' && (mobile === '13800138000' || password === 'your-password')) return true;
    if (name === 'acc3' && (token.includes('真实有效 token') || token.includes('AI 测试时禁止填假 token'))) return true;
    if (email === 'your@email.com' || mobile === '13800138000' || password === 'your-password') return true;
    return false;
}

class AccountPool {
    constructor() {
        this.dataFile = config.ACCOUNTS_FILE;
        this.rootFile = path.join(config.ROOT_DIR, 'accounts.json');
        this.accounts = [];
        this.cursor = 0;
        this._rawCache = null;
        this.reload();
    }

    /** 读取原始账号数据，以 data/accounts.json 为唯一权威源，过滤假账号示例 */
    readRaw() {
        let mRoot = -1;
        let mData = -1;
        try { mRoot = fs.existsSync(this.rootFile) ? fs.statSync(this.rootFile).mtimeMs : -1; } catch (e) {}
        try { mData = fs.existsSync(this.dataFile) ? fs.statSync(this.dataFile).mtimeMs : -1; } catch (e) {}
        if (this._rawCache && this._rawCache.mRoot === mRoot && this._rawCache.mData === mData) {
            return this._rawCache.merged.map(x => ({ ...x }));
        }

        let rootList = [];
        let dataList = [];
        let hasData = false;

        try {
            config.assertNotCDrive(this.dataFile);
            if (fs.existsSync(this.dataFile)) {
                dataList = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
                if (!Array.isArray(dataList)) dataList = [];
                hasData = true;
            }
        } catch (e) {}

        try {
            if (fs.existsSync(this.rootFile)) {
                rootList = JSON.parse(fs.readFileSync(this.rootFile, 'utf8'));
                if (!Array.isArray(rootList)) rootList = [];
            }
        } catch (e) {}

        let merged = [];
        if (hasData) {
            // data/ 为权威主数据；仅当外部明确单独修改了根目录 accounts.json (mRoot > mData) 才接受根目录覆盖
            if (mRoot > mData && rootList.length > 0) {
                merged = rootList;
            } else {
                merged = dataList;
            }
        } else if (rootList.length > 0) {
            merged = rootList;
        }

        // 彻底过滤假账号与示例模板
        const cleanList = merged.filter(a => !isDummyAccount(a));
        this._rawCache = { mRoot, mData, merged: cleanList };

        // 若有清洗或尚未同步，立即双向同步写盘
        if (cleanList.length !== merged.length || !hasData || (mRoot > mData && rootList.length > 0)) {
            this.writeRaw(cleanList);
        }
        return cleanList.map(x => ({ ...x }));
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
        // 写入成功后用新 mtime 回填缓存，紧随其后的 statusSnapshot/readRaw 不再重复读盘
        let mRoot = -1;
        let mData = -1;
        try { mRoot = fs.existsSync(this.rootFile) ? fs.statSync(this.rootFile).mtimeMs : -1; } catch (e) {}
        try { mData = fs.existsSync(this.dataFile) ? fs.statSync(this.dataFile).mtimeMs : -1; } catch (e) {}
        this._rawCache = { mRoot, mData, merged: JSON.parse(str) };
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
                inflight: prev ? (prev.inflight || 0) : 0,
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
    /**
     * 构造"无账号可用"错误：携带 503 状态码，
     * 让网关快速失败并在监控中与普通 500 区分（客户端可据此退避重试）
     */
    _noAccountError(msg, accountName = null) {
        const e = new Error(msg);
        e.statusCode = 503;
        e.noAccount = true;
        if (accountName) e.accountName = accountName;
        return e;
    }

    acquire(excludeNames = [], preferName = null) {
        const n = this.accounts.length;
        if (!n) {
            throw this._noAccountError('账号池为空，请在管理控制台「账号管理」中添加 DeepSeek 账号喵');
        }

        const now = Date.now();
        const excludes = new Set(excludeNames);

        // 1. 过滤已配置 Token 且未被手动禁用的基础账号集合
        const activeAccounts = this.accounts.filter(a => !a.disabled && a.token);
        if (activeAccounts.length === 0) {
            const hasDisabled = this.accounts.some(a => a.disabled);
            const msg = hasDisabled
                ? '所有配置的账号均已被手动停用，请在控制台启用账号调度喵'
                : '账号池内暂无配置有效 Token 的账号，请在控制台填入 userToken 喵';
            const accName = this.accounts.length > 0 ? this.accounts.map(a => a.name).join(',') : null;
            throw this._noAccountError(msg, accName);
        }

        // 2. 检查未被本次 Failover 排除的账号集合
        const nonExcluded = activeAccounts.filter(a => !excludes.has(a.name));
        if (nonExcluded.length === 0) {
            // 本次请求已经将所有账号轮询尝试过一遍
            const pausedFirst = activeAccounts.find(a => a.paused || a.state === STATUS.AUTH_FAILED);
            const msg = (pausedFirst && pausedFirst.lastError)
                ? `所有可用账号均尝试失败（原因: ${pausedFirst.lastError}），请在控制台检查并更新 Token 喵`
                : `池中全部 ${activeAccounts.length} 个账号均已在本次请求中尝试过，暂无更多可用账号喵`;
            const accName = excludeNames.length ? excludeNames.join('->') : activeAccounts.map(a => a.name).join(',');
            throw this._noAccountError(msg, accName);
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
            const accName = pausedList.map(a => a.name).join(',');
            throw this._noAccountError(`可用账号已熔断暂停（原因: ${firstErr}），请在控制台「账号管理」中更新有效 Token 喵`, accName);
        }

        // 5. 若未排除账号都在冷却期中，挑选冷却时间最快到期/在途最少的账号立即尝试自愈，绝不因冷却直接拒绝调度
        const cooldownList = nonExcluded.filter(a => now < a.disabledUntil && !a.paused && a.state !== STATUS.AUTH_FAILED);
        if (cooldownList.length > 0) {
            cooldownList.sort((a, b) => {
                if (a.disabledUntil !== b.disabledUntil) return a.disabledUntil - b.disabledUntil;
                return (a.inflight || 0) - (b.inflight || 0);
            });
            const best = cooldownList[0];
            const waitSec = Math.max(0, Math.round((best.disabledUntil - now) / 1000));
            logger.warn(`账号池暂时都在冷却中，优先借用最快解冻账号 ${best.name}（余 ${waitSec}s）尝试自愈，保持调度不中断喵`);
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

        // 仅在明确遇到 40003 (或确凿的 Token 过期/失效鉴权错误) 时才熔断并暂停调度
        if (isAuthError) {
            acc.state = STATUS.AUTH_FAILED;
            acc.paused = true;
            logger.err(`🚨 账号 ${acc.name} 认证失效 [bizCode=${bizCode}]，已立即熔断并暂停调度！错误: ${errMsg}`);
            this.persistAccountState(acc.name, { paused: true, lastLoginError: errMsg });

            // 若配置了账密且开启 autoLogin，尝试自愈重登
            if (acc.autoLogin && acc.password && (acc.email || acc.mobile)) {
                this.triggerAutoRelogin(acc).catch(() => {});
            }
            return;
        }

        // 官方风控禁言/频控（bizCode=5 等）：只做临时较长退避冷却（如 3 分钟），冷却后自动恢复，绝不暂停调度
        const isMutedOrBanned = bizCode === 5 ||
            /user is muted|account banned|forbidden|被禁言/i.test(errMsg);

        if (isMutedOrBanned) {
            const muteCooldownMs = 180 * 1000;
            acc.disabledUntil = Date.now() + muteCooldownMs;
            acc.state = STATUS.COOLDOWN;
            logger.warn(`⚠️ 账号 ${acc.name} 触发官方风控/频控 [bizCode=${bizCode}]，进入退避冷却 ${Math.round(muteCooldownMs / 1000)}s（冷却后自动恢复，绝不暂停调度）: ${errMsg}`);
            return;
        }

        // 网络抖动 / 空响应 / 停滞超时：短暂轻冷却，冷却后自动继续调度，绝不暂停调度
        const isTransient = /上游网络异常|空响应|连接中断|停滞超时|fetch failed|AbortError|UND_ERR|ECONNRESET|ETIMEDOUT/i.test(errMsg)
            || statusCode === 502 || statusCode === 504;
        if (isTransient) {
            const lightMs = Math.min(3000 * Math.pow(1.5, Math.min(acc.failures - 1, 4)), 15000);
            acc.disabledUntil = Date.now() + lightMs;
            if (acc.state !== STATUS.AUTH_FAILED) {
                acc.state = STATUS.COOLDOWN;
            }
            logger.warn(`账号 ${acc.name} 瞬时网络/上游故障，轻度冷却 ${Math.round(lightMs / 1000)}s（持续可用，不暂停调度）: ${errMsg}`);
            return;
        }

        // 普通错误退避冷却：只要没有 40003，无论失败多少次都绝不暂停调度，仅增加冷却时间
        const shift = Math.min(acc.failures - 1, 5);
        const cooldownMs = Math.min(config.COOLDOWN_BASE_MS * Math.pow(2, shift), config.COOLDOWN_MAX_MS);
        acc.disabledUntil = Date.now() + cooldownMs;
        acc.state = STATUS.COOLDOWN;
        logger.warn(`账号 ${acc.name} 调用异常（第 ${acc.failures} 次），退避冷却 ${Math.round(cooldownMs / 1000)}s（冷却后自动调度，绝不暂停）: ${errMsg}`);
    }

    async triggerAutoRelogin(account) {
        logger.info(`正在为账号 ${account.name} 尝试自动重新登录刷新 Token...`);
        try {
            const dsLogin = require('./ds-login');
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
                const failReason = r.error || '自动重登未成功';
                logger.err(`账号 ${account.name} 自动重登未成功: ${failReason}`);
                const failPatch = {
                    lastLoginError: failReason,
                    paused: true,
                };
                if (r.deviceId) failPatch.deviceId = r.deviceId;
                this.updateAccount(account.index, failPatch);
                return false;
            }
        } catch (e) {
            logger.err(`账号 ${account.name} 自动重登异常: ${e.message}`);
            this.updateAccount(account.index, { lastLoginError: '自动重登异常: ' + e.message, paused: true });
            return false;
        }
    }

    /**
     * 持久化单个账号的运行时状态。
     * 按 name 定位（而非 index）：readRaw 每次合并双文件后顺序可能变化，按 index 会打错账号。
     */
    persistAccountState(name, patch) {
        const raw = this.readRaw();
        const idx = typeof name === 'string'
            ? raw.findIndex(a => (a.name || '') === name)
            : name;
        if (idx >= 0 && idx < raw.length) {
            Object.assign(raw[idx], patch);
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
