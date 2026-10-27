"""Tool registry and the context object every tool handler receives."""

import logging
import shutil
import time
import traceback
from pathlib import Path

import pymupdf as fitz

from .. import engines
from ..engines import Cancelled, EngineError
from ..storage import write_json
from ..utils import PageRangeError, safe_stem, unique_path, zip_files

log = logging.getLogger("pdfplume.tools")

TOOLS = {}


class ToolError(Exception):
    """An error whose message is shown to the user."""


def tool(slug, accept=("pdf",), min_files=1, max_files=None, zip_name=None):
    """Register a handler. ``accept`` lists the file kinds the tool takes."""

    def deco(fn):
        TOOLS[slug] = {
            "slug": slug,
            "handler": fn,
            "accept": tuple(accept),
            "min_files": min_files,
            "max_files": max_files,
            "zip_name": zip_name or f"pdfplume_{slug.replace('-', '_')}.zip",
        }
        return fn

    return deco


class InputFile:
    def __init__(self, data):
        self.id = data.get("id")
        self.path = Path(data["path"])
        self.name = data.get("name") or self.path.name
        self.ext = (data.get("ext") or self.path.suffix).lower()
        self.kind = data.get("kind", "other")
        self.password = data.get("password") or ""
        self.options = data.get("options") or {}

    @property
    def stem(self):
        return safe_stem(self.name)

    def __repr__(self):
        return f"<InputFile {self.name}>"


class ToolContext:
    def __init__(self, slug, inputs, options, job_dir):
        self.slug = slug
        self.inputs = [InputFile(i) for i in inputs]
        self.options = options or {}
        self.job_dir = Path(job_dir)
        self.out_dir = self.job_dir / "out"
        self.work_dir = self.job_dir / "work"
        self.assets_dir = self.out_dir / "assets"
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.outputs = []
        self.extra = {}
        self.zip_name = TOOLS[slug]["zip_name"] if slug in TOOLS else "pdfplume.zip"
        self._last_progress = 0.0

    # ---- options ---------------------------------------------------------
    def opt(self, key, default=None):
        value = self.options.get(key, default)
        return default if value is None else value

    # ---- progress --------------------------------------------------------
    def check_cancel(self):
        if (self.job_dir / "cancel").exists():
            raise Cancelled()

    def progress(self, fraction, message=None, force=False):
        self.check_cancel()
        now = time.time()
        if not force and now - self._last_progress < 0.25:
            return
        self._last_progress = now
        data = {"progress": max(0.0, min(1.0, float(fraction)))}
        if message:
            data["message"] = message
        try:
            write_json(self.job_dir / "progress.json", data)
        except OSError:
            pass

    # ---- files -------------------------------------------------------------
    def output_path(self, filename):
        return unique_path(self.out_dir, filename)

    def work_path(self, filename):
        return unique_path(self.work_dir, filename)

    def asset_path(self, filename):
        self.assets_dir.mkdir(exist_ok=True)
        return self.assets_dir / filename

    def add_output(self, path):
        self.outputs.append(Path(path))
        return Path(path)

    def open_pdf(self, inp):
        try:
            doc = fitz.open(inp.path)
        except Exception:
            raise ToolError(f"'{inp.name}' is damaged or is not a valid PDF. Try Repair PDF first.")
        if not doc.is_pdf:
            doc.close()
            raise ToolError(f"'{inp.name}' is not a PDF file.")
        if doc.needs_pass:
            if not inp.password or not doc.authenticate(inp.password):
                doc.close()
                raise ToolError(f"'{inp.name}' is password protected. "
                                "Enter the correct password and try again.")
        return doc

    def decrypted_path(self, inp):
        """Path of an unencrypted copy of ``inp`` (for external programs)."""
        import pikepdf
        try:
            with pikepdf.open(inp.path, password=inp.password or "") as pdf:
                if not pdf.is_encrypted:
                    return inp.path
                out = self.work_path(f"{inp.stem}_decrypted.pdf")
                pdf.save(out)
                return out
        except pikepdf.PasswordError:
            raise ToolError(f"'{inp.name}' is password protected. "
                            "Enter the correct password and try again.")
        except Exception:
            return inp.path

    def save_pdf(self, doc, filename, garbage=3):
        path = self.output_path(filename)
        doc.save(path, garbage=garbage, deflate=True)
        return self.add_output(path)

    def inputs_of(self, *kinds):
        return [i for i in self.inputs if i.kind in kinds]


def _finalize(ctx):
    if not ctx.outputs:
        raise ToolError("Nothing was produced. Check the options and try again.")
    outputs = [p for p in ctx.outputs if p.exists()]
    if len(outputs) == 1:
        main = outputs[0]
    else:
        main = zip_files(outputs, unique_path(ctx.out_dir, ctx.zip_name))
    return {
        "status": "done",
        "file": main.name,
        "size": main.stat().st_size,
        "count": len(outputs),
        "outputs": [{"name": p.name, "size": p.stat().st_size} for p in outputs],
        "original_size": sum(i.path.stat().st_size for i in ctx.inputs if i.path.exists()),
        "extra": ctx.extra,
    }


def run_job(slug, inputs, options, job_dir):
    """Entry point executed in a worker process."""
    _load_all()
    job_dir = Path(job_dir)
    started = time.time()
    engines.set_cancel_check(lambda: (job_dir / "cancel").exists())
    try:
        spec = TOOLS[slug]
        ctx = ToolContext(slug, inputs, options, job_dir)
        ctx.progress(0.02, "Starting", force=True)
        spec["handler"](ctx)
        result = _finalize(ctx)
    except Cancelled:
        result = {"status": "cancelled", "message": "Cancelled"}
    except (ToolError, EngineError, PageRangeError) as exc:
        result = {"status": "error", "message": str(exc)}
    except Exception as exc:  # pragma: no cover - unexpected bugs
        log.error("Tool %s failed:\n%s", slug, traceback.format_exc())
        result = {"status": "error", "message": f"Unexpected error: {exc}"}
    finally:
        shutil.rmtree(job_dir / "work", ignore_errors=True)
    result["elapsed"] = round(time.time() - started, 2)
    result["tool"] = slug
    write_json(job_dir / "result.json", result)
    return result


_loaded = False


def _load_all():
    global _loaded
    if _loaded:
        return
    from . import (convert_from, convert_to, edit, forms, intelligence,  # noqa: F401
                   layout, optimize, organize, security)
    fitz.TOOLS.mupdf_display_errors(False)
    fitz.TOOLS.mupdf_display_warnings(False)
    _loaded = True


def registry():
    _load_all()
    return TOOLS

