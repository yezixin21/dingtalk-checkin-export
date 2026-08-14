@echo off
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0..\..\node.exe" set "NODE=%~dp0..\..\node.exe"

echo Starting CLI export...
echo.
"%NODE%" export_node.js
pause
