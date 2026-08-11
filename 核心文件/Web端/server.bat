@echo off
cd /d "%~dp0"
echo Starting DingTalk Checkin Export Server...
echo URL: http://localhost:3000
echo.
"%~dp0..\..\nodejs\node.exe" server.js
if %errorlevel% neq 0 pause
