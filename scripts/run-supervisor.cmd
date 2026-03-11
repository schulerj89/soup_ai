@echo off
setlocal
set NODE_NO_WARNINGS=1
cd /d "%~dp0.."
call npm.cmd run supervisor:once
endlocal
