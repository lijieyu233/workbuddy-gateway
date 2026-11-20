@echo off
rem LAN mode. ASCII-only for the same reason as start.bat.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title WorkBuddy Gateway (LAN)

where node >nul 2>nul
if errorlevel 1 goto nonode

node src\cli.js --lan --open
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" echo   Gateway exited with code %CODE%.
echo   Closing this window stops the gateway.
echo.
pause
exit /b %CODE%

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install Node.js 22 or newer from https://nodejs.org/
echo.
pause
exit /b 1
