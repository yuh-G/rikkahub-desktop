@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > nul
set CARGO_TARGET_DIR=C:\rikkahub-build
cd /d "%~dp0"
C:\Users\WhizWiz\.cargo\bin\cargo.exe %*
exit /b %errorlevel%
