"""Runtime configuration, read from environment variables."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


HOST = os.environ.get("PDFPLUME_HOST", "127.0.0.1")
PORT = _int("PDFPLUME_PORT", 8765)
DATA_DIR = Path(os.environ.get("PDFPLUME_DATA_DIR", PROJECT_DIR / "data")).resolve()

# Uploaded and processed files are deleted after this many minutes.
FILE_TTL_MINUTES = _int("PDFPLUME_FILE_TTL_MINUTES", 120)
MAX_UPLOAD_MB = _int("PDFPLUME_MAX_UPLOAD_MB", 1024)
WORKERS = _int("PDFPLUME_WORKERS", max(1, min(4, (os.cpu_count() or 2))))

# Optional external services (never required).
LIBRETRANSLATE_URL = os.environ.get("LIBRETRANSLATE_URL", "").rstrip("/")
LIBRETRANSLATE_API_KEY = os.environ.get("LIBRETRANSLATE_API_KEY", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")

# Comma separated list of engines to pretend are missing (used by tests to
# exercise the pure-Python fallbacks): soffice,gs,tesseract,chrome,playwright
DISABLED_ENGINES = {
    e.strip() for e in os.environ.get("PDFPLUME_DISABLE_ENGINES", "").split(",") if e.strip()
}
