@echo off
rem Native desktop launcher. ASCII-only: a UTF-8 .bat is parsed as GBK by cmd.
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" goto noelectron
if not exist "..\src\cli.js" goto nosource

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:noelectron
echo.
echo   [ERROR] Electron is not installed in desktop\node_modules.
echo   Run this once in the project root:
echo.
echo       cd desktop
echo       npm install
echo.
echo   If the download is slow in your region, set the mirror first:
echo       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo.
pause
exit /b 1

:nosource
echo.
echo   [ERROR] Cannot find ..\src\cli.js
echo   This launcher must stay inside the project's desktop folder.
echo.
pause
exit /b 1
