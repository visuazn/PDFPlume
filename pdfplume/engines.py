"""Detection and invocation of optional external programs.

Every tool has a pure-Python implementation, but a few produce noticeably
better results when one of these programs is installed:

* LibreOffice  - Word / PowerPoint / Excel to PDF (exact layout)
* Ghostscript  - stronger compression and validated PDF/A output
* Tesseract    - OCR (required for the OCR tool and for scanned documents)
* Chrome / Playwright - HTML to PDF with full CSS and JavaScript support
"""

import functools
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import config


class EngineError(RuntimeError):
    pass


class Cancelled(BaseException):
    """The user cancelled the running job.

    A BaseException (like KeyboardInterrupt) so that the many ``except
    Exception`` blocks around optional steps never swallow it.
    """


_cancel_check = None


def set_cancel_check(fn):
    """Register a callable that returns True once the current job is cancelled."""
    global _cancel_check
    _cancel_check = fn


def cancelled():
    return bool(_cancel_check and _cancel_check())


def _disabled(name):
    return name in config.DISABLED_ENGINES


def _first_existing(candidates):
    for c in candidates:
        if not c:
            continue
        found = shutil.which(c)
        if found:
            return found
        for match in sorted(glob.glob(c), reverse=True):
            if os.path.isfile(match):
                return match
    return None


@functools.lru_cache(maxsize=None)
def soffice_path():
    if _disabled("soffice"):
        return None
    return _first_existing([
        os.environ.get("PDFPLUME_SOFFICE"),
        "soffice", "libreoffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/opt/libreoffice*/program/soffice",
        "/usr/lib/libreoffice/program/soffice",
    ])


@functools.lru_cache(maxsize=None)
def ghostscript_path():
    if _disabled("gs"):
        return None
    return _first_existing([
        os.environ.get("PDFPLUME_GHOSTSCRIPT"),
        "gs", "gswin64c", "gswin32c",
        r"C:\Program Files\gs\gs*\bin\gswin64c.exe",
        r"C:\Program Files (x86)\gs\gs*\bin\gswin32c.exe",
        "/opt/homebrew/bin/gs", "/usr/local/bin/gs",
    ])


@functools.lru_cache(maxsize=None)
def tesseract_path():
    if _disabled("tesseract"):
        return None
    return _first_existing([
        os.environ.get("PDFPLUME_TESSERACT"),
        "tesseract",
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract",
    ])


@functools.lru_cache(maxsize=None)
def chrome_path():
    if _disabled("chrome"):
        return None
    return _first_existing([
        os.environ.get("PDFPLUME_CHROME"),
        "chrome-headless-shell",
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
        "msedge", "microsoft-edge",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        # Browsers downloaded by Playwright (headless shell first: it starts fastest).
        "/opt/pw-browsers/chromium_headless_shell-*/chrome-*/chrome-headless-shell",
        os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell"),
        "/opt/pw-browsers/chromium-*/chrome-linux*/chrome",
        os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
    ])


@functools.lru_cache(maxsize=None)
def playwright_available():
    if _disabled("playwright"):
        return False
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except Exception:
        return False


@functools.lru_cache(maxsize=None)
def tesseract_languages():
    exe = tesseract_path()
    if not exe:
        return []
    try:
        out = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=20)
    except Exception:
        return []
    langs = []
    for line in (out.stdout + "\n" + out.stderr).splitlines():
        line = line.strip()
        if not line or " " in line or line.endswith(":") or line == "osd":
            continue
        langs.append(line)
    return sorted(set(langs))


def run_program(cmd, timeout, what, env=None, check=True):
    """Run an external program; it is killed if the job is cancelled or times out."""
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as exc:
        raise EngineError(f"Could not start {what}: {exc}")
    deadline = time.monotonic() + timeout
    while True:
        try:
            out, err = proc.communicate(timeout=0.4)
            break
        except subprocess.TimeoutExpired:
            stop = Cancelled() if cancelled() else (
                EngineError(f"{what} took too long and was stopped.") if time.monotonic() > deadline else None)
            if stop:
                proc.kill()
                proc.communicate()
                raise stop
    result = subprocess.CompletedProcess(cmd, proc.returncode, out, err)
    if check and proc.returncode != 0:
        msg = (err or out or b"").decode("utf-8", "replace").strip()
        raise EngineError(f"{what} failed: {msg[-500:] or 'exit code %d' % proc.returncode}")
    return result



def soffice_convert(src, out_dir, fmt="pdf", timeout=300):
    """Convert ``src`` with LibreOffice; returns the path of the converted file."""
    exe = soffice_path()
    if not exe:
        raise EngineError("LibreOffice is not installed.")
    src = Path(src)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # A private profile per conversion lets several conversions run in parallel.
    with tempfile.TemporaryDirectory(prefix="pdfplume_lo_") as profile:
        cmd = [exe, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless",
               "--norestore", "--nologo", "--nodefault", "--nolockcheck",
               "--convert-to", fmt, "--outdir", str(out_dir), str(src)]
        run_program(cmd, timeout, "LibreOffice")
    ext = fmt.split(":")[0]
    result = out_dir / f"{src.stem}.{ext}"
    if not result.exists():
        raise EngineError("LibreOffice did not produce an output file. Is the document valid?")
    return result


def ghostscript(args, timeout=600):
    exe = ghostscript_path()
    if not exe:
        raise EngineError("Ghostscript is not installed.")
    return run_program([exe, "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER", *args], timeout, "Ghostscript")


def tesseract_pdf(image_path, lang, dpi, timeout=600):
    """Run Tesseract on one image and return a text-only (invisible) PDF page as bytes."""
    exe = tesseract_path()
    if not exe:
        raise EngineError("Tesseract OCR is not installed.")
    cmd = [exe, str(image_path), "stdout", "-l", lang, "--dpi", str(int(dpi)),
           "-c", "textonly_pdf=1", "pdf"]
    # Tesseract's OpenMP threads slow down dramatically when the CPU is busy
    # (several jobs, a browser animating); one thread per page is barely slower.
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    return run_program(cmd, timeout, "Tesseract", env=env).stdout


def capabilities():
    return {
        "libreoffice": bool(soffice_path()),
        "ghostscript": bool(ghostscript_path()),
        "tesseract": bool(tesseract_path()),
        "tesseract_languages": tesseract_languages(),
        "html_engine": "playwright" if (playwright_available() and chrome_or_bundled())
        else ("chrome" if chrome_path() else "basic"),
        "python": sys.version.split()[0],
    }


def chrome_or_bundled():
    """Playwright needs either its own downloaded browser or a system Chrome."""
    if chrome_path():
        return True
    return bool(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium*"))) or \
        bool(os.environ.get("PLAYWRIGHT_BROWSERS_PATH"))
