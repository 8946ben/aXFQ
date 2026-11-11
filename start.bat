@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Electron 宿主（WorkBuddy / Claude Code）常设置此变量，会让 Electron 退化成纯 Node
set ELECTRON_RUN_AS_NODE=
echo Starting A-SOUL Floating Ball ...
node launch.js
if errorlevel 1 (
  echo.
  echo [FAILED] press any key to close.
  pause >nul
)
