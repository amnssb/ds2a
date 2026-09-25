@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DeepSeek Studio (客户端换 Token 工作台)
echo ======================================================
echo   DeepSeek Studio 客户端已在当前用户桌面启动喵
echo   访问工作台: http://127.0.0.1:19729/
echo   在此窗口运行下，勾选「有头」换 Token 将直接弹出 Chrome 窗口喵
echo ======================================================
node studio\server.js
pause
