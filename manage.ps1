<#
  manage.ps1 - DeepSeek Gateway Management CLI (Windows PowerShell)
  Usage:
    .\manage.ps1 start     - Start service in background
    .\manage.ps1 stop      - Stop service
    .\manage.ps1 restart   - Restart service
    .\manage.ps1 status    - View service and account health
    .\manage.ps1 test      - Send test request to gateway
    .\manage.ps1 logs      - Follow live server log
#>
param([Parameter(Position=0)][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $here 'server.pid'
$logFile = Join-Path $here 'logs\server.log'
$errFile = Join-Path $here 'logs\server.err.log'

$logsDir = Join-Path $here 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

function Get-Running {
    if (-not (Test-Path $pidFile)) { return $null }
    $raw = (Get-Content -LiteralPath $pidFile -Raw)
    if (-not $raw) { return $null }
    $procId = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$procId)) { return $null }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    if ($p.ProcessName -ne 'node') { return $null }
    return $p
}

function Show-Status {
    $p = Get-Running
    if ($p) {
        $wsMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
        Write-Host "==========================================================" -ForegroundColor DarkCyan
        Write-Host "  DeepSeek Gateway: [RUNNING]" -ForegroundColor Green
        Write-Host "  PID:         $($p.Id) (Memory: ${wsMb} MB)"
        Write-Host "  Started:     $($p.StartTime)"
        Write-Host "  OpenAI API:  http://127.0.0.1:34868/v1/chat/completions"
        Write-Host "  Claude API:  http://127.0.0.1:34868/v1/messages"
        Write-Host "  Dashboard:   http://127.0.0.1:34868/panel/"
        Write-Host "----------------------------------------------------------" -ForegroundColor DarkCyan

        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:34868/health' -TimeoutSec 4
            $wasmTxt = if ($h.wasmAcceleration) { "Active (85ms/100k difficulty)" } else { "JS Fallback" }
            Write-Host "  WASM Acceleration: $wasmTxt" -ForegroundColor Cyan
            Write-Host "  Accounts: $($h.healthyAccounts) / $($h.totalAccounts) Healthy"

            $h.accounts | ForEach-Object {
                $color = if ($_.healthy) { "Green" } elseif ($_.state -eq 'paused' -or $_.state -eq 'auth_failed') { "Red" } else { "Yellow" }
                Write-Host "    [$($_.name)] State: $($_.state) | OK: $($_.ok) Err: $($_.err)" -ForegroundColor $color
                if ($_.lastError) {
                    Write-Host "      LastError: $($_.lastError)" -ForegroundColor DarkGray
                }
            }
        } catch {
            Write-Host '  Health check: Initializing or busy' -ForegroundColor Yellow
        }
        Write-Host "==========================================================" -ForegroundColor DarkCyan
    } else {
        Write-Host '[STOPPED]' -ForegroundColor Yellow
    }
}

function Start-Svc {
    $p = Get-Running
    if ($p) {
        Write-Host "Already running (PID $($p.Id))" -ForegroundColor Yellow
        return
    }
    if (Test-Path $pidFile) { Remove-Item -LiteralPath $pidFile -Force }

    Write-Host 'Starting DeepSeek Gateway ...' -ForegroundColor Cyan
    $proc = Start-Process -FilePath 'node' `
        -ArgumentList 'server.js' `
        -WorkingDirectory $here `
        -PassThru -WindowStyle Hidden

    $proc.Id | Out-File -LiteralPath $pidFile -Encoding ascii -NoNewline
    Start-Sleep -Seconds 2

    $p2 = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($p2) {
        Write-Host "[STARTED] PID $($proc.Id)" -ForegroundColor Green
    } else {
        Write-Host '[START FAILED]' -ForegroundColor Red
        if (Test-Path $errFile) { Get-Content -LiteralPath $errFile -Tail 20 }
    }
}

function Stop-Svc {
    $p = Get-Running
    if (-not $p) {
        Write-Host 'Service is not running' -ForegroundColor Yellow
        if (Test-Path $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
        return
    }
    Write-Host "Stopping PID $($p.Id) ..." -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force
    Start-Sleep -Seconds 1
    if (Test-Path $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    Write-Host 'Service stopped' -ForegroundColor Green
}

function Test-Api {
    Write-Host 'Sending test prompt to gateway ...' -ForegroundColor Cyan
    $t0 = Get-Date
    try {
        $bodyObj = @{
            model = "deepseek-v4.1-flash"
            messages = @(@{ role = "user"; content = "Hello" })
            stream = $false
        }
        $body = ConvertTo-Json -InputObject $bodyObj

        $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:34868/v1/chat/completions' `
            -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 30

        $cost = [math]::Round(((Get-Date) - $t0).TotalMilliseconds)
        Write-Host "Test Succeeded! Latency: ${cost}ms" -ForegroundColor Green
        Write-Host "Reply: $($resp.choices[0].message.content)"
    } catch {
        Write-Host "Test Failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

switch ($Action.ToLower()) {
    'start'   { Start-Svc; Show-Status }
    'stop'    { Stop-Svc }
    'restart' { Stop-Svc; Start-Sleep -Seconds 1; Start-Svc; Show-Status }
    'status'  { Show-Status }
    'test'    { Test-Api }
    'logs'    {
        if (Test-Path $logFile) { Get-Content -LiteralPath $logFile -Tail 60 -Wait }
        else { Write-Host 'No log file yet' }
    }
    default   { Write-Host 'Usage: .\manage.ps1 [start|stop|restart|status|test|logs]' }
}