@echo off
cd /d "%~dp0"
echo ========================================
echo   DingTalk Checkin Export - Setup
echo ========================================
echo.
echo This script will download portable Node.js for this project.
echo It only needs to run ONCE on a new computer.
echo.

if exist "%~dp0node.exe" (
    echo [OK] Portable Node.js already exists. No setup needed.
    echo.
    pause
    exit /b 0
)

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] System Node.js detected. Portable version is optional.
    echo You can already use the .bat files.
    echo.
    choice /C YN /M "Download portable Node.js anyway"
    if errorlevel 2 goto :skip
)

set "NODE_VER=v26.7.0"

echo.
echo Downloading Node.js %NODE_VER% (portable, ~40MB)...
echo Mirror: npmmirror.com
echo.

set "NODE_URL=https://registry.npmmirror.com/-/binary/node/%NODE_VER%/win-x64/node.exe"

echo Saving to: %~dp0node.exe
echo.

powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%~dp0node.exe' -UseBasicParsing"

if not exist "%~dp0node.exe" (
    echo.
    echo [FAIL] Download failed. Please check your internet connection.
    echo You can also install Node.js manually: https://nodejs.org
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Setup complete!
echo ========================================
echo.
echo Node.js installed to: %~dp0node.exe
echo.
echo Next steps:
echo   1. Copy .env.example to .env and fill in your credentials
echo   2. Double-click server.bat or daily_checkin.bat
echo.

:skip
pause
