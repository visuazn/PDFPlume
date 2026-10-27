@echo off
rem Build the stand-alone Windows app. Needs Python 3.10+ (python.org installer).
cd /d "%~dp0\.."
py -3 -m venv .build-venv || python -m venv .build-venv
.build-venv\Scripts\python -m pip install --upgrade pip
.build-venv\Scripts\python -m pip install -r requirements.txt pyinstaller
.build-venv\Scripts\pyinstaller --noconfirm --clean packaging\pdfplume.spec
echo.
echo Done: dist\PDFPlume\PDFPlume.exe
pause
