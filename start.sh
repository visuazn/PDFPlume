#!/usr/bin/env bash
# Start PDFPlume on Linux / macOS. Creates a virtual environment on first run.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
if [ ! -x .venv/bin/python ]; then
  echo "Creating virtual environment in .venv ..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
fi
if [ ! -f .venv/.deps-installed ] || [ requirements.txt -nt .venv/.deps-installed ]; then
  echo "Installing dependencies ..."
  .venv/bin/python -m pip install -r requirements.txt
  touch .venv/.deps-installed
fi
exec .venv/bin/python run.py --open "$@"
