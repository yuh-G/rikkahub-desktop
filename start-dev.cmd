@echo off
title Rikkahub Dev Launcher

set ROOT=%~dp0

echo ========================================
echo   Rikkahub Dev Frontend Only
echo ========================================
echo.

:: Check Bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Bun not found. Install: npm install -g bun
    pause
    exit /b 1
)

:: Kill any OLD Rikkahub server windows from previous runs
echo [CLEANUP] Closing old Rikkahub windows...
taskkill /fi "WINDOWTITLE eq Rikkahub*" /f >nul 2>&1

:: Install frontend dependencies if missing
if not exist "%ROOT%web-ui\node_modules\" (
    echo [INSTALL] web-ui dependencies...
    cd /d "%ROOT%web-ui"
    call bun install
)

:: Start ONLY the frontend Vite dev server
echo [START] Frontend only...
start "Rikkahub Web" cmd /c "cd /d "%ROOT%web-ui" && echo Frontend ready at http://localhost:5173 && bun run dev && pause"

:: Wait for frontend
echo [WAIT] Waiting for frontend...
:wait
timeout /t 1 /nobreak >nul
curl.exe -s -o nul http://localhost:5173/ 2>nul
if %errorlevel% neq 0 goto wait

echo [READY] http://localhost:5173
start http://localhost:5173

echo.
echo ========================================
echo   Frontend: http://localhost:5173
echo.
echo   Backend is NOT started by this script.
echo   Close this window to stop.
echo ========================================
echo.
pause
