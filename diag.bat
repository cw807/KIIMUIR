@echo off
set PYTHONUTF8=1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%~dp0diag.py" > "%~dp0data\diag.txt" 2>&1
