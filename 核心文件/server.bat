@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动钉钉签到导出服务...
echo.
node server.js
pause
