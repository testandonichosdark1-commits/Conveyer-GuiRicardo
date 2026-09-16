@echo off
setlocal
cd /d "%~dp0"
title Faceless Video Generator

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules not found — installing dependencies first...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo ============================================
echo   Faceless Video Generator — starting dev server
echo   Browser will open at http://localhost:3000
echo   To stop: close this window or press Ctrl+C
echo ============================================
echo.

REM Wait 3 seconds, then open the browser in the background
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

call npm run dev
