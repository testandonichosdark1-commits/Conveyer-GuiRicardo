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

REM The optional wigolo photo-search daemon, if one was started. Safe when it never was —
REM it prints "nothing to stop" and exits. It also refuses to kill a recycled pid that
REM doesn't belong to wigolo, so this can't take an unrelated process down with it.
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  call node scripts/wigolo.mjs stop 2>nul
)

echo.
echo Done. You can close this window or run start.bat again.
timeout /t 3 /nobreak >nul
