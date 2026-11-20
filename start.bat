@echo off
rem ASCII-only launcher. Chinese text lives in Node, not here: a UTF-8 .bat
rem is parsed byte-by-byte by cmd as GBK, which corrupts every Chinese line.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title WorkBuddy Gateway

where node >nul 2>nul
if errorlevel 1 goto nonode

set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--open"

node src\cli.js %ARGS%
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" echo   Gateway exited with code %CODE%. The message above is the reason.
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
