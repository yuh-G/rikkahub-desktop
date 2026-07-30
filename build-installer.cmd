@echo off
setlocal
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" > nul
if errorlevel 1 (
  echo Failed to activate MSVC build tools.
  exit /b 1
)
set "PATH=%USERPROFILE%\.cargo\bin;%USERPROFILE%\AppData\Roaming\npm;%USERPROFILE%\AppData\Roaming\npm\node_modules\bun\bin;%PATH%"
cd /d "D:\PythonProject\rikkahub-desktop\web-ui"
bun run tauri:build -- --bundles nsis
pause
exit /b %errorlevel%
