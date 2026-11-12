@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installation des dependances...
  call npm install --silent
)
start "" http://127.0.0.1:8787
node src/server.js
pause
