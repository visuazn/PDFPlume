#!/usr/bin/env bash
# Build the stand-alone app for this computer (macOS or Linux). Needs Python 3.10+.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
"$PY" -m venv .build-venv
.build-venv/bin/python -m pip install --upgrade pip
.build-venv/bin/python -m pip install -r requirements.txt pyinstaller
.build-venv/bin/pyinstaller --noconfirm --clean packaging/pdfplume.spec
echo
if [ -d dist/PDFPlume.app ]; then
  echo "Done: dist/PDFPlume.app (drag it to Applications)"
else
  echo "Done: dist/PDFPlume/PDFPlume"
fi
