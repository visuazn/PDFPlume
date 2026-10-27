@echo off
rem Start PDFPlume on Windows. Creates a virtual environment on first run.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Creating virtual environment in .venv ...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo Python 3.10+ is required: https://www.python.org/downloads/
    pause
    exit /b 1
  )
  .venv\Scripts\python.exe -m pip install --upgrade pip
)
if not exist .venv\.deps-installed (
  echo Installing dependencies ...
  .venv\Scripts\python.exe -m pip install -r requirements.txt || (pause & exit /b 1)
  echo ok> .venv\.deps-installed
)
.venv\Scripts\python.exe run.py --open %*
pause
