@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set code=%ERRORLEVEL%
if not "%code%"=="0" pause
exit /b %code%
