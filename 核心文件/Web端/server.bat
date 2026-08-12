@echo off
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0..\..\nodejs\node.exe" set "NODE=%~dp0..\..\nodejs\node.exe"

echo Starting DingTalk Checkin Export Server...
echo URL: http://localhost:3000
echo.
"%NODE%" server.js
if %errorlevel% neq 0 pause
