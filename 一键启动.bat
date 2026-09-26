@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DeepSeek 一键启动

echo ============================================================
echo   DeepSeek 网关 + Studio 一键启动喵
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 后重试喵
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行，正在安装依赖喵...
  call npm install
)

call :portInUse 19728
if "%ERRORLEVEL%"=="0" (
  echo [跳过] 网关已在运行 (19728) 喵
) else (
  echo 正在启动网关服务 (19728) ...喵
  start "DS-Gateway" /min cmd /c "node server.js"
)

call :portInUse 19729
if "%ERRORLEVEL%"=="0" (
  echo [跳过] Studio 已在运行 (19729) 喵
) else (
  echo 正在启动 Studio 客户端 (19729) ...喵
  start "DS-Studio" cmd /c "node studio\server.js"
)

timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:19729/

echo.
echo ------------------------------------------------------------
echo  已启动喵：
echo    Studio 工作台 : http://127.0.0.1:19729/
echo    网关控制台   : http://127.0.0.1:19728/panel/
echo  关闭本窗口不会停止服务喵，停止请运行 manage.ps1 stop
echo ------------------------------------------------------------
echo.
pause
exit /b 0

:portInUse
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (exit /b 1)
exit /b 0
