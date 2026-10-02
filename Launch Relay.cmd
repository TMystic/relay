@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  call npm install
  if errorlevel 1 goto failed
)
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Relay could not start. See the error above and README.md for setup instructions.
pause
exit /b 1
