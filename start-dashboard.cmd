@echo off
setlocal
cd /d "%~dp0"

rem ====================================================================
rem  Jira Worklog Dashboard - double-click launcher
rem  Starts the local server and opens it in your browser.
rem ====================================================================

set "PORT=3877"
set "URL=http://127.0.0.1:%PORT%"
title Jira Worklog Dashboard

rem --- 1. If it's already running, just open the browser and exit ------
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%);exit 0}catch{exit 1}"
if %errorlevel%==0 (
  echo The dashboard is already running - opening it in your browser...
  start "" "%URL%"
  timeout /t 2 >nul
  exit /b 0
)

rem --- 2. Make sure Node.js is installed -------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Please install the LTS version from https://nodejs.org/ and then
  echo   double-click this file again.
  echo.
  pause
  exit /b 1
)

rem --- 3. First run: install dependencies -----------------------------
if not exist "node_modules" (
  echo.
  echo   First-time setup: installing dependencies. This can take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Setup failed. Please send the messages above to whoever set this up.
    echo.
    pause
    exit /b 1
  )
)

rem --- 4. Open the browser once the server is listening (background) ---
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 120;$i++){try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%);Start-Process '%URL%';break}catch{Start-Sleep -Milliseconds 400}}"

rem --- 5. Start the server in this window ------------------------------
echo.
echo   Starting the Jira Worklog Dashboard...
echo   Your browser will open automatically at %URL%
echo.
echo   KEEP THIS WINDOW OPEN while you use the dashboard.
echo   To stop it, close this window or press Ctrl+C.
echo.
call npm start

rem If the server exits on its own, keep the window so errors stay visible.
echo.
echo   The dashboard has stopped.
pause
