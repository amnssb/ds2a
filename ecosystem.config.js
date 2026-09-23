'use strict';
/**
 * ecosystem.config.js — PM2 生产级守护进程配置
 */
const path = require('path');

module.exports = {
    apps: [{
        name: 'ds-gateway',
        script: './server.js',
        cwd: __dirname,
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '800M',
        env: {
            NODE_ENV: 'production',
            PORT: 19728,
            HOST: '0.0.0.0',
            DS_DATA_DIR: path.join(__dirname, 'data'),
            DS_LOGS_DIR: path.join(__dirname, 'logs'),
            // .env 由 src/config.js 自行加载；此处不覆盖已有 process.env 语义
        },
        error_file: path.join(__dirname, 'logs', 'server.err.log'),
        out_file: path.join(__dirname, 'logs', 'server.log'),
        merge_logs: true,
        time: true,
    }],
};
