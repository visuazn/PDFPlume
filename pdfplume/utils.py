"""Small helpers shared by the server and the tools."""

import re
import unicodedata
import zipfile
from pathlib import Path

try:  # iPhone photos (HEIC/HEIF) become readable by Pillow everywhere.
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:  # pragma: no cover - optional dependency
    pass

PDF_EXT = {".pdf"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".heic", ".heif"}
WORD_EXT = {".doc", ".docx", ".odt", ".rtf", ".txt"}
PPT_EXT = {".ppt", ".pptx", ".pps", ".ppsx", ".odp"}
EXCEL_EXT = {".xls", ".xlsx", ".ods", ".csv"}
HTML_EXT = {".html", ".htm"}


def file_kind(ext):
    ext = ext.lower()
    if ext in PDF_EXT:
        return "pdf"
    if ext in IMAGE_EXT:
        return "image"
    if ext in WORD_EXT:
        return "word"
    if ext in PPT_EXT:
        return "powerpoint"
    if ext in EXCEL_EXT:
        return "excel"
    if ext in HTML_EXT:
        return "html"
    return "other"


def safe_stem(name, default="document"):
    """A filesystem- and header-safe version of a file name without extension."""
    stem = Path(name or "").stem
    stem = unicodedata.normalize("NFC", stem)
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", stem).strip(" ._")
    return stem[:120] or default


def unique_path(directory, filename):
    directory = Path(directory)
    path = directory / filename
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    i = 2
    while True:
        candidate = directory / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def zip_files(paths, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        used = set()
        for p in paths:
            arc = Path(p).name
            n = 2
            while arc in used:
                arc = f"{Path(p).stem}_{n}{Path(p).suffix}"
                n += 1
            used.add(arc)
            zf.write(p, arc)
    return zip_path


class PageRangeError(ValueError):
    pass


def parse_page_ranges(spec, page_count, allow_empty=False):
    """Parse ``"1-3, 5, 8-"`` into a list of 0-based page indexes (in order).

    Supports open ranges (``"5-"``, ``"-3"``), ``"all"``, ``"last"`` /
    ``"end"`` and reversed ranges (``"5-3"``).
    """
    spec = (spec or "").strip().lower()
    if not spec:
        if allow_empty:
            return []
        raise PageRangeError("Please enter the pages you want, e.g. 1-3, 5.")
    if spec in ("all", "*"):
        return list(range(page_count))

    def to_num(tok, default):
        tok = tok.strip()
        if not tok:
            return default
        if tok in ("last", "end", "n"):
            return page_count
        if not tok.isdigit():
            raise PageRangeError(f"'{tok}' is not a valid page number.")
        return int(tok)

    pages = []
    for part in re.split(r"[,;\s]+", spec):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = to_num(a, 1), to_num(b, page_count)
        else:
            start = end = to_num(part, None)
        for n in (start, end):
            if n < 1 or n > page_count:
                raise PageRangeError(
                    f"Page {n} does not exist - the document has {page_count} page(s).")
        step = 1 if end >= start else -1
        pages.extend(range(start - 1, end - 1 + step, step))
    if not pages and not allow_empty:
        raise PageRangeError("No pages selected.")
    return pages


def parse_color(value, default=(0, 0, 0)):
    """``#rgb`` / ``#rrggbb`` -> (r, g, b) floats in 0..1."""
    if value is None or value == "":
        return default
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return tuple(float(v) / (255 if max(value) > 1 else 1) for v in value)
    v = str(value).strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", v):
        return default
    return tuple(int(v[i:i + 2], 16) / 255 for i in (0, 2, 4))


def human_size(num):
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.2f} {unit}"
        num /= 1024
    return f"{num:.2f} GB"


def clamp(value, lo, hi):
    return max(lo, min(hi, value))


def to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def to_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def to_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")
