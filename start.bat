@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing...
  call npm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)
start "" http://localhost:3000
node server.js
pause
