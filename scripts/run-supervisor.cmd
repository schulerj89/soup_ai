@echo off
setlocal
set NODE_NO_WARNINGS=1
cd /d "%~dp0.."
node src\cli\supervisor-serve.js
endlocal
