@echo off
setlocal
REM Wrapper that activates MSVC + uses an ASCII target dir, then runs any tauri command.
REM Workaround for two Windows dev quirks:
REM   1. cargo needs MSVC's link.exe; Git Bash's PATH otherwise resolves link to coreutils.
REM   2. CARGO_TARGET_DIR lives outside the project path because the project path contains
REM      non-ASCII characters and some build scripts mishandle that.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > nul
if errorlevel 1 (
  echo Failed to activate MSVC build tools. Is Visual Studio Build Tools 2022 installed?
  exit /b 1
)
REM vcvars resets PATH; restore cargo + bun on top so the Tauri CLI can find them.
set "PATH=%USERPROFILE%\.cargo\bin;%USERPROFILE%\.bun\bin;%PATH%"
set CARGO_TARGET_DIR=C:\rikkahub-build
cd /d "%~dp0\.."
bun run tauri %*
exit /b %errorlevel%

