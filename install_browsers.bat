@echo off
set PYTHONUTF8=1
set PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -m playwright install chromium > "%~dp0data\install.log" 2>&1
echo DONE_EXIT_%ERRORLEVEL% >> "%~dp0data\install.log"
