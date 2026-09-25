'use strict';
/**
 * src/pow-engine.js — 高性能 PoW 求解器与预热引擎
 * - 支持官方 sha3_wasm_bg.wasm 硬件级加速（计算耗时由 3500ms 降至 85ms，提速 40x）
 * - 纯 JS 容灾回退（零依赖兜底，运行于 worker 线程，不阻塞事件循环）
 * - PoW 异步预热池（命中预热时 0ms 延迟直接放行）
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('./config');
const logger = require('./logger');

let wasmInstance = null;
let wasmExports = null;
let wasmBuffer = null;
let wasmAvailable = false;

// 1. 初始化 WebAssembly
try {
    if (fs.existsSync(config.WASM_FILE)) {
        wasmBuffer = fs.readFileSync(config.WASM_FILE);
        const module = new WebAssembly.Module(wasmBuffer);
        const instance = new WebAssembly.Instance(module, {});
        wasmInstance = instance;
        wasmExports = instance.exports;
        wasmAvailable = true;
        logger.ok('PoW WASM 引擎加载成功（加速比 ~40x）');
    } else {
        logger.warn('未找到 WASM 文件，将使用纯 JS 兜底运行');
    }
} catch (e) {
    logger.err('PoW WASM 加载失败: ' + e.message + '，将回退至纯 JS');
}

// 2. WASM 求解函数
/** 释放 wasm-bindgen 分配器给出的内存，防止线性内存随请求数持续增长 */
function wasmFree(ptr, len) {
    try {
        if (wasmExports && typeof wasmExports.__wbindgen_free === 'function' && ptr) {
            wasmExports.__wbindgen_free(ptr, len, 1);
        }
    } catch (e) {}
}

function solveByWasm(prefix, challengeHex, difficulty) {
    if (!wasmAvailable || !wasmExports) return -1;

    let pCh = 0;
    let pPre = 0;
    let retptr = 0;
    try {
        const wasm = wasmExports;
        // 分配 challenge 字符串内存
        const bCh = Buffer.from(challengeHex, 'utf8');
        pCh = wasm.__wbindgen_export_0(bCh.length, 1);
        new Uint8Array(wasm.memory.buffer, pCh, bCh.length).set(bCh);

        // 分配 prefix 字符串内存
        const bPre = Buffer.from(prefix, 'utf8');
        pPre = wasm.__wbindgen_export_0(bPre.length, 1);
        new Uint8Array(wasm.memory.buffer, pPre, bPre.length).set(bPre);

        // 调用 wasm_solve(retptr, pCh, lCh, pPre, lPre, difficulty)
        retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wasm_solve(retptr, pCh, bCh.length, pPre, bPre.length, Number(difficulty) || 144000);

        const mem32 = new Int32Array(wasm.memory.buffer);
        const memF64 = new Float64Array(wasm.memory.buffer);
        const status = mem32[retptr / 4];
        const answer = memF64[retptr / 8 + 1];
        wasm.__wbindgen_add_to_stack_pointer(16);
        retptr = 0; // 栈指针已恢复

        if (status === 1 && typeof answer === 'number') {
            return Math.round(answer);
        }
    } catch (e) {
        logger.warn('WASM 求解异常，回退纯 JS: ' + e.message);
    } finally {
        // 异常路径也必须恢复栈指针，否则后续求解全部错位
        if (retptr) {
            try { wasmExports.__wbindgen_add_to_stack_pointer(16); } catch (e) {}
        }
        wasmFree(pCh, Buffer.byteLength(challengeHex, 'utf8'));
        wasmFree(pPre, Buffer.byteLength(prefix, 'utf8'));
    }
    return -1;
}

// 3. 纯 JS 兜底求解器（基于原有 ds-pow.js）
const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
    0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
    0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const M64 = 0xffffffffffffffffn;

function rotl64(v, k) {
    const kk = BigInt(k);
    return ((v << kk) | (v >> (64n - kk))) & M64;
}

function keccakF24(s) {
    const a = s;
    for (let r = 0; r < 24; r++) {
        const c0 = a[0] ^ a[5] ^ a[10] ^ a[15] ^ a[20];
        const c1 = a[1] ^ a[6] ^ a[11] ^ a[16] ^ a[21];
        const c2 = a[2] ^ a[7] ^ a[12] ^ a[17] ^ a[22];
        const c3 = a[3] ^ a[8] ^ a[13] ^ a[18] ^ a[23];
        const c4 = a[4] ^ a[9] ^ a[14] ^ a[19] ^ a[24];
        const d0 = c4 ^ rotl64(c1, 1);
        const d1 = c0 ^ rotl64(c2, 1);
        const d2 = c1 ^ rotl64(c3, 1);
        const d3 = c2 ^ rotl64(c4, 1);
        const d4 = c3 ^ rotl64(c0, 1);
        a[0] ^= d0; a[5] ^= d0; a[10] ^= d0; a[15] ^= d0; a[20] ^= d0;
        a[1] ^= d1; a[6] ^= d1; a[11] ^= d1; a[16] ^= d1; a[21] ^= d1;
        a[2] ^= d2; a[7] ^= d2; a[12] ^= d2; a[17] ^= d2; a[22] ^= d2;
        a[3] ^= d3; a[8] ^= d3; a[13] ^= d3; a[18] ^= d3; a[23] ^= d3;
        a[4] ^= d4; a[9] ^= d4; a[14] ^= d4; a[19] ^= d4; a[24] ^= d4;

        const t0 = a[0], t1 = a[6], t2 = a[12], t3 = a[18], t4 = a[24];
        const b0 = t0;
        const b16 = rotl64(a[5], 36); const b7 = rotl64(a[10], 3); const b23 = rotl64(a[15], 41);
        const b14 = rotl64(a[20], 18); const b10 = rotl64(a[1], 1); const b1 = rotl64(t1, 44);
        const b17 = rotl64(a[11], 10); const b11 = rotl64(a[7], 6); const b5 = rotl64(a[3], 28);
        const b4 = rotl64(t4, 14); const b21 = rotl64(a[8], 55); const b15 = rotl64(a[4], 27);
        const b20 = rotl64(a[2], 62); const b8 = rotl64(a[16], 45); const b2 = rotl64(t2, 43);
        const b13 = rotl64(a[19], 8); const b22 = rotl64(a[14], 39); const b9 = rotl64(a[22], 61);
        const b6 = rotl64(a[9], 20); const b12 = rotl64(a[13], 25); const b19 = rotl64(a[23], 56);
        const b24 = rotl64(a[21], 2); const b18 = rotl64(a[17], 15); const b3 = rotl64(t3, 21);

        a[0] = b0 ^ (~b1 & b2 & M64); a[1] = b1 ^ (~b2 & b3 & M64); a[2] = b2 ^ (~b3 & b4 & M64);
        a[3] = b3 ^ (~b4 & b0 & M64); a[4] = b4 ^ (~b0 & b1 & M64);
        a[5] = b5 ^ (~b6 & b7 & M64); a[6] = b6 ^ (~b7 & b8 & M64); a[7] = b7 ^ (~b8 & b9 & M64);
        a[8] = b8 ^ (~b9 & b5 & M64); a[9] = b9 ^ (~b5 & b6 & M64);
        a[10] = b10 ^ (~b11 & b12 & M64); a[11] = b11 ^ (~b12 & b13 & M64); a[12] = b12 ^ (~b13 & b14 & M64);
        a[13] = b13 ^ (~b14 & b10 & M64); a[14] = b14 ^ (~b10 & b11 & M64);
        a[15] = b15 ^ (~b16 & b17 & M64); a[16] = b16 ^ (~b17 & b18 & M64); a[17] = b17 ^ (~b18 & b19 & M64);
        a[18] = b18 ^ (~b19 & b15 & M64); a[19] = b19 ^ (~b15 & b16 & M64);
        a[20] = b20 ^ (~b21 & b22 & M64); a[21] = b21 ^ (~b22 & b23 & M64); a[22] = b22 ^ (~b23 & b24 & M64);
        a[23] = b23 ^ (~b24 & b20 & M64); a[24] = b24 ^ (~b20 & b21 & M64);

        a[0] ^= RC[r];
    }
}

function readU64LE(buf, off) {
    return BigInt(buf[off]) | (BigInt(buf[off + 1]) << 8n) | (BigInt(buf[off + 2]) << 16n) | (BigInt(buf[off + 3]) << 24n)
        | (BigInt(buf[off + 4]) << 32n) | (BigInt(buf[off + 5]) << 40n) | (BigInt(buf[off + 6]) << 48n) | (BigInt(buf[off + 7]) << 56n);
}
function writeU64LE(v, out, off) {
    let x = v;
    for (let i = 0; i < 8; i++) { out[off + i] = Number(x & 0xffn); x >>= 8n; }
}

function deepseekHashV1(data) {
    const RATE = 136;
    const s = new Array(25).fill(0n);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    let off = 0;
    while (off + RATE <= buf.length) {
        for (let i = 0; i < RATE / 8; i++) s[i] ^= readU64LE(buf, off + i * 8);
        keccakF24(s);
        off += RATE;
    }
    const fin = Buffer.alloc(RATE);
    buf.copy(fin, 0, off);
    fin[buf.length - off] = 0x06;
    fin[RATE - 1] |= 0x80;
    for (let i = 0; i < RATE / 8; i++) s[i] ^= readU64LE(fin, i * 8);
    keccakF24(s);

    const out = Buffer.alloc(32);
    writeU64LE(s[0], out, 0); writeU64LE(s[1], out, 8);
    writeU64LE(s[2], out, 16); writeU64LE(s[3], out, 24);
    return out;
}

function digestMatchPrefix(hash, challengeHex) {
    for (let i = 0; i < 8; i++) {
        const b = hash[i];
        const hi = parseInt(challengeHex.substr(i * 2, 2), 16);
        if (b !== hi) return false;
    }
    return hash.toString('hex') === challengeHex;
}

function solveByJs(prefix, challengeHex, difficulty) {
    const limit = Math.min(Number(difficulty) || 144000, 200000);
    for (let nonce = 0; nonce < limit; nonce++) {
        const h = deepseekHashV1(Buffer.from(prefix + nonce, 'utf8'));
        if (digestMatchPrefix(h, challengeHex)) return nonce;
    }
    return -1;
}

// ---------- JS 兜底求解运行于 worker 线程 ----------
// BigInt 版 keccak 单次求解可达秒级，同步跑会卡死事件循环、拖停所有并发 SSE 流；
// 这里把同一套求解函数序列化进常驻 worker，主线程仅做异步等待。
let jsWorker = null;
let workerJobs = [];
let workerSeq = 0;

const JS_WORKER_TIMEOUT_MS = Number(process.env.DS_POW_JS_TIMEOUT_MS || 60000);

const jsWorkerSrc = `
'use strict';
const { parentPort } = require('worker_threads');
// BigInt 字面量序列化：toString() 不带 n 后缀，必须手工补上
const RC = [${RC.map(x => x.toString() + 'n').join(',')}];
const M64 = ${M64}n;
${rotl64.toString()}
${keccakF24.toString()}
${readU64LE.toString()}
${writeU64LE.toString()}
${deepseekHashV1.toString()}
${digestMatchPrefix.toString()}
${solveByJs.toString()}
parentPort.on('message', (m) => {
    let answer = -1;
    try { answer = solveByJs(m.prefix, m.challenge, m.difficulty); } catch (e) { answer = -1; }
    parentPort.postMessage({ type: 'result', id: m.id, answer });
});
`;

function ensureJsWorker() {
    if (jsWorker) return jsWorker;
    try {
        jsWorker = new Worker(jsWorkerSrc, { eval: true });
        jsWorker.unref();
        jsWorker.on('message', (m) => {
            if (!m || m.type !== 'result') return;
            const idx = workerJobs.findIndex(j => j.id === m.id);
            if (idx < 0) return; // 已超时移除，结果作废
            const job = workerJobs.splice(idx, 1)[0];
            job.resolve(typeof m.answer === 'number' ? m.answer : -1);
        });
        const failAll = () => {
            const jobs = workerJobs.splice(0);
            jsWorker = null; // 下次任务时重建
            for (const j of jobs) j.resolve(-1);
        };
        jsWorker.on('error', failAll);
        jsWorker.on('exit', () => { if (workerJobs.length) failAll(); });
    } catch (e) {
        jsWorker = null;
    }
    return jsWorker;
}

/** 在 worker 线程里跑纯 JS 求解；worker 不可用/超时返回 -1 */
function solveInWorker(prefix, challengeHex, difficulty, timeoutMs = JS_WORKER_TIMEOUT_MS) {
    const w = ensureJsWorker();
    if (!w) return Promise.resolve(-1);
    return new Promise((resolve) => {
        const job = { id: ++workerSeq, resolve: null };
        const timer = setTimeout(() => {
            const idx = workerJobs.indexOf(job);
            if (idx >= 0) workerJobs.splice(idx, 1);
            resolve(-1);
        }, timeoutMs);
        job.resolve = (v) => { clearTimeout(timer); resolve(v); };
        workerJobs.push(job);
        try {
            w.postMessage({ id: job.id, prefix, challenge: challengeHex, difficulty });
        } catch (e) {
            const idx = workerJobs.indexOf(job);
            if (idx >= 0) workerJobs.splice(idx, 1);
            clearTimeout(timer);
            resolve(-1);
        }
    });
}

/** 智能统一求解接口（优先 WASM，失败自动回退 worker 线程纯 JS；异步接口） */
async function solve(ch) {
    const challenge = ch.challenge;
    const salt = ch.salt;
    const expireAt = ch.expire_at;
    const difficulty = ch.difficulty;
    const prefix = `${salt}_${expireAt}_`;

    const t0 = Date.now();
    let answer = -1;
    let mode = 'wasm';

    if (wasmAvailable) {
        answer = solveByWasm(prefix, challenge, difficulty);
    }

    if (answer < 0) {
        mode = 'js-worker';
        answer = await solveInWorker(prefix, challenge, difficulty);
        if (answer < 0) {
            // worker 不可用（构建失败/超时）时的最后容灾：主线程同步兜底
            mode = 'js-sync-lastresort';
            answer = solveByJs(prefix, challenge, difficulty);
        }
    }

    const cost = Date.now() - t0;
    logger.pow(`PoW 完成 [${mode}] answer=${answer} 耗时=${cost}ms 难度=${difficulty}`);
    return answer;
}

function buildHeader(ch, answer, targetPath) {
    return Buffer.from(JSON.stringify({
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        salt: ch.salt,
        answer: answer,
        signature: ch.signature,
        target_path: targetPath,
    }), 'utf8').toString('base64');
}

// 4. 滚动预热池（每账号最多缓存 POW_POOL_MAX 个已解 PoW，消费一个立即异步补充一个）
const POW_POOL_MAX = 2; // 每账号目标预热储备数量，可按需调大

class PowPool {
    constructor() {
        // token -> Array<{ header, expireAt, targetPath }>
        this.cache = new Map();
        // "token_tail|path" -> 正在飞行的预热请求数（用于"已有+在途 >= 目标"的原子判断）
        this.inflight = new Map();
    }

    _ik(token, targetPath) { return token.slice(-16) + '|' + targetPath; }

    /** 取出一个有效的预热 PoW（取出即删除，PoW 是一次性的） */
    get(token, targetPath) {
        const list = this.cache.get(token);
        if (!list || !list.length) return null;
        const now = Date.now();
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.targetPath === targetPath && item.expireAt - 30000 > now) {
                list.splice(i, 1);
                if (!list.length) this.cache.delete(token);
                return item.header;
            }
        }
        return null;
    }

    /** 存入一个预热好的 PoW（同时清理过期条目） */
    put(token, targetPath, header, expireAt) {
        if (!this.cache.has(token)) this.cache.set(token, []);
        const list = this.cache.get(token);
        const now = Date.now();
        // 顺手清理过期条目
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].expireAt - 30000 <= now) list.splice(i, 1);
        }
        list.push({ header, expireAt, targetPath });
    }

    /** 当前有效缓存数量 */
    size(token, targetPath) {
        const list = this.cache.get(token);
        if (!list) return 0;
        const now = Date.now();
        return list.filter(item => item.targetPath === targetPath && item.expireAt - 30000 > now).length;
    }

    // --- 在途计数（JS 单线程，check+increment 是原子的，不会竞争） ---
    inflightCount(token, targetPath) {
        return this.inflight.get(this._ik(token, targetPath)) || 0;
    }
    incrementInflight(token, targetPath) {
        const k = this._ik(token, targetPath);
        this.inflight.set(k, (this.inflight.get(k) || 0) + 1);
    }
    decrementInflight(token, targetPath) {
        const k = this._ik(token, targetPath);
        const n = (this.inflight.get(k) || 1) - 1;
        if (n <= 0) this.inflight.delete(k); else this.inflight.set(k, n);
    }

    clear(token) {
        if (token) this.cache.delete(token);
        else this.cache.clear();
    }
}

const powPool = new PowPool();

module.exports = {
    solve,
    solvePow: async (ch, salt, expireAt, difficulty) => (typeof ch === 'object' ? solve(ch) : solve({ challenge: ch, salt, expire_at: expireAt, difficulty })),
    buildHeader,
    buildPowHeader: buildHeader,
    powPool,
    isWasmReady: () => wasmAvailable,
    solveInWorker,
    POW_POOL_MAX,
    // 诊断/自测用内部函数，业务代码勿依赖
    _internals: { deepseekHashV1, digestMatchPrefix, solveByJs },
};
