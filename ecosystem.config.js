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
            PORT: 34868,
            HOST: '127.0.0.1',
            DS_DATA_DIR: path.join(__dirname, 'data'),
            DS_LOGS_DIR: path.join(__dirname, 'logs'),
        },
        error_file: path.join(__dirname, 'logs', 'server.err.log'),
        out_file: path.join(__dirname, 'logs', 'server.log'),
        merge_logs: true,
        time: true,
    }],
};
