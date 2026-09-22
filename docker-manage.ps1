<#
  docker-manage.ps1 - DeepSeek Gateway Docker Management CLI (PowerShell)
  Usage:
    .\docker-manage.ps1 up       - Build & start container in background
    .\docker-manage.ps1 down     - Stop & remove container
    .\docker-manage.ps1 restart  - Restart container
    .\docker-manage.ps1 build    - Rebuild docker image
    .\docker-manage.ps1 status   - Check container status & health
    .\docker-manage.ps1 logs     - View container real-time logs
#>
param([Parameter(Position=0)][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $here

# 自动从 .env.example 生成 .env
if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
    Copy-Item '.env.example' '.env'
    Write-Host "Created .env from .env.example" -ForegroundColor Green
}

switch ($Action.ToLower()) {
    'up' {
        Write-Host "Starting DeepSeek Gateway container ..." -ForegroundColor Cyan
        docker compose up -d --build
        Write-Host "Container started! API: http://127.0.0.1:34868/v1/chat/completions" -ForegroundColor Green
        Write-Host "Dashboard: http://127.0.0.1:34868/panel/" -ForegroundColor Green
    }
    'down' {
        Write-Host "Stopping DeepSeek Gateway container ..." -ForegroundColor Cyan
        docker compose down
        Write-Host "Container stopped." -ForegroundColor Green
    }
    'restart' {
        Write-Host "Restarting DeepSeek Gateway container ..." -ForegroundColor Cyan
        docker compose restart
    }
    'build' {
        Write-Host "Rebuilding Docker image ..." -ForegroundColor Cyan
        docker compose build --no-cache
    }
    'status' {
        Write-Host "================ Container Status ================" -ForegroundColor DarkCyan
        docker compose ps
        Write-Host "--------------------------------------------------" -ForegroundColor DarkCyan
        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:34868/health' -TimeoutSec 3
            Write-Host "Gateway Health: $($h.status) | Healthy Accounts: $($h.healthyAccounts)/$($h.totalAccounts)" -ForegroundColor Green
        } catch {
            Write-Host "Gateway Health Check: Container starting or stopped" -ForegroundColor Yellow
        }
    }
    'logs' {
        docker compose logs -f --tail 100
    }
    default {
        Write-Host "Usage: .\docker-manage.ps1 [up|down|restart|build|status|logs]"
    }
}
