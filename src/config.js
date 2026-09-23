'use strict';
/**
 * src/config.js — 全局配置与安全路径定义
 * 严格遵循非 C 盘存储规范，所有数据与日志均落盘于 D 盘项目目录内
 */
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '..');

// 零依赖加载 .env（不引入 dotenv；已有 process.env 优先）
(function loadEnvFile() {
    const envPath = path.join(ROOT_DIR, '.env');
    try {
        if (!fs.existsSync(envPath)) return;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const s = line.trim();
            if (!s || s.startsWith('#')) continue;
            const eq = s.indexOf('=');
            if (eq <= 0) continue;
            const k = s.slice(0, eq).trim();
            let v = s.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
            }
            if (!(k in process.env)) process.env[k] = v;
        }
    } catch (e) {
        console.error('[config] 加载 .env 失败:', e.message);
    }
})();

const DATA_DIR = process.env.DS_DATA_DIR ? path.resolve(process.env.DS_DATA_DIR) : path.join(ROOT_DIR, 'data');
const LOGS_DIR = process.env.DS_LOGS_DIR ? path.resolve(process.env.DS_LOGS_DIR) : path.join(ROOT_DIR, 'logs');
const VENDOR_DIR = path.join(ROOT_DIR, 'vendor');
const PANEL_DIR = path.join(ROOT_DIR, 'panel');

// 安全防护：禁止把任何文件写入 C 盘
function assertNotCDrive(targetPath) {
    const resolved = path.resolve(targetPath);
    if (/^[cC]:/i.test(resolved)) {
        throw new Error(`[Security Alert] 检测到试图写入 C 盘路径: ${resolved}，已被安全规则拦截！`);
    }
    return resolved;
}

// 确保目录存在
[DATA_DIR, LOGS_DIR].forEach(dir => {
    assertNotCDrive(dir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 数据文件路径（优先使用 data/，若旧文件在根目录则自动兼容/迁移）
function resolveDataFile(filename) {
    const dataPath = path.join(DATA_DIR, filename);
    const rootPath = path.join(ROOT_DIR, filename);
    if (!fs.existsSync(dataPath) && fs.existsSync(rootPath)) {
        // 将现有根目录数据文件迁移至 data/ 目录
        try {
            fs.copyFileSync(rootPath, dataPath);
            console.log(`[config] 已从根目录迁移数据文件至 data/: ${filename}`);
        } catch (e) {
            return rootPath;
        }
    }
    return dataPath;
}

const ACCOUNTS_FILE = resolveDataFile('accounts.json');
const AUTH_DATA_FILE = resolveDataFile('auth-data.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const REQUESTS_LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');
const APP_LOG_FILE = path.join(LOGS_DIR, 'server.log');
const ERR_LOG_FILE = path.join(LOGS_DIR, 'server.err.log');
const WASM_FILE = path.join(VENDOR_DIR, 'sha3_wasm_bg.wasm');

module.exports = {
    ROOT_DIR,
    DATA_DIR,
    LOGS_DIR,
    VENDOR_DIR,
    PANEL_DIR,
    ACCOUNTS_FILE,
    AUTH_DATA_FILE,
    STATS_FILE,
    REQUESTS_LOG_FILE,
    APP_LOG_FILE,
    ERR_LOG_FILE,
    WASM_FILE,
    assertNotCDrive,

    // 服务网络配置（0.0.0.0 允许公网或局域网远程访问）
    PORT: Number(process.env.PORT || 19728),
    HOST: process.env.HOST || '0.0.0.0',

    // 管理员认证
    ADMIN_USER: process.env.DS_ADMIN_USER || 'admin',
    ADMIN_PASS: process.env.DS_ADMIN_PASS || 'admin123',
    REQUIRE_KEY: process.env.DS_REQUIRE_KEY === 'true',

    // 会话与超时
    SESSION_TTL_MS: Math.max(1, Number(process.env.DS_SESSION_TTL_MIN || 15)) * 60 * 1000,
    REQUEST_TIMEOUT_MS: Number(process.env.DS_TIMEOUT_MS || 90000),
    MAX_UPLOAD_MB: Number(process.env.DS_MAX_UPLOAD_MB || 30),

    // 账号与并发控制
    MAX_CONCURRENT_PER_ACCOUNT: Number(process.env.DS_MAX_CONCURRENT_PER_ACCOUNT || 5),
    CIRCUIT_BREAKER_FAIL_LIMIT: Number(process.env.DS_CIRCUIT_BREAKER_FAIL_LIMIT || 2), // 连续失败 N 次进入熔断
    COOLDOWN_BASE_MS: 30000,               // 初始退避 30s
    COOLDOWN_MAX_MS: 900000,               // 最大退避 15m

    // PoW 预热配置
    POW_PREWARM_ENABLED: process.env.DS_POW_PREWARM !== 'false',
    POW_PREWARM_CONCURRENCY: 2,

    // DeepSeek 接口地址与请求头
    DEEPSEEK: {
        BASE: 'https://chat.deepseek.com',
        CREATE_SESSION: '/api/v0/chat_session/create',
        DELETE_SESSION: '/api/v0/chat_session/delete',
        POW_CHALLENGE: '/api/v0/chat/create_pow_challenge',
        COMPLETION: '/api/v0/chat/completion',
        STOP_STREAM: '/api/v0/chat/stop_stream',
        UPLOAD_FILE: '/api/v0/file/upload_file',
        FILE_STATUS: '/api/v0/file/query_file_status',
        LOGIN: '/api/v0/users/login',
        USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
};
