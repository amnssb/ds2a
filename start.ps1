# 启动 DeepSeek 网关（纯 HTTP，无浏览器）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $here

Write-Host '启动 DeepSeek 网关 ...' -ForegroundColor Cyan
node server.js
