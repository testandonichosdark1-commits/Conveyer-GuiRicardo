@echo off
setlocal
cd /d "%~dp0"
title Faceless Video Generator — Installation

echo.
echo ============================================
echo   Faceless Video Generator — installation
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install Node.js 20+ from https://nodejs.org/
  echo Then run install.bat again.
  pause
  exit /b 1
)

echo Installing dependencies (this may take a few minutes)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. See messages above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Done! Run start.bat to launch the app.
echo ============================================
echo.
pause
