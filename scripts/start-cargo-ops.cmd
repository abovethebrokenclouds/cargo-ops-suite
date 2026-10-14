@echo off
rem Cargo Ops launcher for Windows. Double-click it or run it from a terminal.
rem Checks Node.js, then hands over to start-cargo-ops.ps1, which installs the
rem connector dependencies, builds what is missing and starts the connector on
rem http://127.0.0.1:4311 with the browser opening automatically.
rem Extra arguments are passed to the connector, e.g. --sim fake --loop, or
rem --lan to let a paired tablet on your home network in (docs\SETUP_WINDOWS.md section 15)
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 24 LTS from https://nodejs.org ^(the "LTS" button^), then run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if %NODE_MAJOR% LSS 22 goto oldnode
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto oldnode

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-cargo-ops.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo Cargo Ops stopped with exit code %CODE%. See the messages above.
  pause
)
exit /b %CODE%

:oldnode
echo.
echo Node.js %NODE_MAJOR%.%NODE_MINOR% is too old for Cargo Ops.
echo Install Node.js 24 LTS from https://nodejs.org ^(22.13 or newer also works^).
echo.
pause
exit /b 1
