@echo off
rem Builds the Cargo Ops toolbar panel with the free MSFS SDK and copies it into the
rem simulator's Community folder (docs\SETUP_WINDOWS.md "Toolbar panel").
rem Extra arguments go to build-msfs-panel.ps1, e.g. -Port 4312, -Remove, -DetectOnly,
rem -SdkPath "C:\MSFS SDK" or -Community "D:\MSFS\Community". No administrator rights needed.
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-msfs-panel.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo The toolbar panel was not built ^(exit code %CODE%^). See the messages above.
  pause
)
exit /b %CODE%
