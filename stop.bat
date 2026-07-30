@echo off
setlocal
title Conveyer Grok — Stop

echo Looking for processes on port 3000...
echo.

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":3000.*LISTENING"') do (
  set "FOUND=1"
  echo Killing PID %%P
  taskkill /PID %%P /F >nul 2>nul
)

if not defined FOUND (
  echo No process found on port 3000.
)

echo.
echo Done. You can close this window or run start.bat again.
timeout /t 3 /nobreak >nul
