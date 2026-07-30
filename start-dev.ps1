#Requires -Version 5.1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = "bun"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Rikkahub Dev Mode Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Bun
if (-not (Get-Command $bun -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Bun not found. Install: npm install -g bun" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[OK] Bun $(& $bun --version)" -ForegroundColor Green

# Check dependencies
if (-not (Test-Path "$root\pc-server\node_modules")) {
    Write-Host "[INSTALL] pc-server dependencies..." -ForegroundColor Yellow
    Push-Location "$root\pc-server"
    & $bun install
    Pop-Location
} else {
    Write-Host "[OK] pc-server dependencies installed" -ForegroundColor Green
}

if (-not (Test-Path "$root\web-ui\node_modules")) {
    Write-Host "[INSTALL] web-ui dependencies..." -ForegroundColor Yellow
    Push-Location "$root\web-ui"
    & $bun install
    Pop-Location
} else {
    Write-Host "[OK] web-ui dependencies installed" -ForegroundColor Green
}

# Kill processes blocking our ports
Write-Host "[CLEANUP] Checking ports..." -ForegroundColor Yellow
function Free-Port($port) {
    $used = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
    foreach ($entry in $used) {
        $tokens = $entry.ToString().Trim() -split '\s+'
        $pid = $tokens[-1]
        if ($pid -match '^\d+$') {
            Write-Host "  Port $port is used by PID $pid, stopping..." -ForegroundColor DarkYellow
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
}
Free-Port 8080
Free-Port 5173

# Start backend
Write-Host "[START] Backend pc-server (port 8080)..." -ForegroundColor Green
Start-Process cmd -ArgumentList "/c cd /d `"$root\pc-server`" && bun run server.ts && pause" -WindowStyle Normal

# Wait for backend
Write-Host "[WAIT] Waiting for backend..." -ForegroundColor Yellow
$backendReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://localhost:8080/")
        $req.Timeout = 1000
        $resp = $req.GetResponse()
        $resp.Close()
        $backendReady = $true
        break
    } catch {
        Write-Host "." -NoNewline -ForegroundColor DarkGray
    }
}
if (-not $backendReady) {
    # Check if it started on an alternative port
    $altPorts = netstat -ano | Select-String ":808\d\s" | Select-String "LISTENING"
    if ($altPorts) {
        Write-Host ""
        Write-Host "[WARN] Backend may have started on an alternative port:" -ForegroundColor Yellow
        $altPorts | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    } else {
        Write-Host ""
        Write-Host "[ERROR] Backend failed to start" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}
Write-Host ""
Write-Host "[READY] Backend online at http://localhost:8080" -ForegroundColor Green

# Start frontend
Write-Host "[START] Frontend Vite dev server (port 5173)..." -ForegroundColor Green
Start-Process cmd -ArgumentList "/c cd /d `"$root\web-ui`" && bun run dev && pause" -WindowStyle Normal

# Wait for frontend
Write-Host "[WAIT] Waiting for frontend..." -ForegroundColor Yellow
$frontendReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://localhost:5173/")
        $req.Timeout = 1000
        $resp = $req.GetResponse()
        $resp.Close()
        $frontendReady = $true
        break
    } catch {
        Write-Host "." -NoNewline -ForegroundColor DarkGray
    }
}
if (-not $frontendReady) {
    Write-Host ""
    Write-Host "[ERROR] Frontend failed to start" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host ""
Write-Host "[READY] Frontend online at http://localhost:5173" -ForegroundColor Green

# Open browser
Start-Process "http://localhost:5173"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All services are running!" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:8080" -ForegroundColor Cyan
Write-Host "  Frontend: http://localhost:5173" -ForegroundColor Cyan
Write-Host "  Browser:  opened at localhost:5173" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Close the server/web windows to stop" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Keep this window open so user can see the status
Read-Host "Press Enter to close this window"
