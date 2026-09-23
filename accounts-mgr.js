'use strict';
/**
 * 根目录桥接兼容层：将 accounts-mgr.js 统一桥接至 src/account-pool.js
 */
const accountPool = require('./src/account-pool');

module.exports = {
    forWorkers: () => accountPool.readRaw(),
    list: (reveal = false) => accountPool.readRaw().map((a, i) => ({
        index: i,
        name: a.name || ('acc' + (i + 1)),
        email: a.email || '',
        mobile: a.mobile || '',
        areaCode: a.areaCode || '+86',
        token: reveal ? (a.token || '') : (a.token ? (a.token.slice(0, 6) + '…' + a.token.slice(-4)) : ''),
        hasToken: !!a.token,
        hasPassword: !!a.password,
        autoLogin: a.autoLogin !== false,
        disabled: !!a.disabled,
        paused: !!a.paused,
    })),
    add: (data) => accountPool.addAccount(data),
    update: (index, data) => accountPool.updateAccount(index, data),
    remove: (index) => accountPool.removeAccount(index),
    readRaw: () => accountPool.readRaw(),
    writeRaw: (list) => accountPool.writeRaw(list),
};