@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0rikkahub-pc.exe" (
  echo RikkaHub PC is starting. Press Ctrl+C in this window to stop it.
  "%~dp0rikkahub-pc.exe"
  pause
  exit /b %errorlevel%
)
echo rikkahub-pc.exe was not found next to this script.
echo Please copy this script into the packaged dist directory.
pause
