"""Page layout: pages per sheet (N-up), booklets, resizing, grayscale."""

import math

import pymupdf as fitz

from .. import engines
from ..utils import clamp, to_bool, to_float, to_int
from . import ToolError, tool

MM = 72 / 25.4
SHEETS = {"a4": fitz.paper_rect("a4"), "letter": fitz.paper_rect("letter"), "legal": fitz.paper_rect("legal"),
          "a3": fitz.paper_rect("a3"), "a5": fitz.paper_rect("a5")}
GRIDS = {2: (2, 1), 4: (2, 2), 6: (3, 2), 8: (4, 2), 9: (3, 3), 16: (4, 4)}


def _sheet(name, like):
    """(width, height) of the named paper size, or of ``like`` for 'same'."""
    r = SHEETS.get(name)
    return (r.width, r.height) if r else (like.width, like.height)


def _fit(cell, w, h):
    """Largest rect with aspect w:h centred in ``cell``."""
    k = min(cell.width / w, cell.height / h)
    cw, ch = w * k, h * k
    x = cell.x0 + (cell.width - cw) / 2
    y = cell.y0 + (cell.height - ch) / 2
    return fitz.Rect(x, y, x + cw, y + ch)


def _place(page, cell, src, pno, border=False):
    sp = src[pno]
    target = _fit(cell, sp.rect.width, sp.rect.height)
    page.show_pdf_page(target, src, pno, keep_proportion=True)
    if border:
        page.draw_rect(target, color=(0.6, 0.6, 0.65), width=0.5)


# ---------------------------------------------------------------- N-up
@tool("nup_pdf", zip_name="pdfplume_nup.zip")
def nup_pdf(ctx):
    per = to_int(ctx.opt("per_sheet"), 4)
    if per not in GRIDS:
        raise ToolError("Choose 2, 4, 6, 8, 9 or 16 pages per sheet.")
    margin = clamp(to_float(ctx.opt("margin"), 8), 0, 40) * MM
    gap = clamp(to_float(ctx.opt("gap"), 4), 0, 30) * MM
    order = ctx.opt("order", "rows")
    border = to_bool(ctx.opt("border"))
    for inp in ctx.inputs:
        src = ctx.open_pdf(inp)
        first = src[0].rect
        w, h = _sheet(ctx.opt("sheet", "a4"), first)
        a, b = GRIDS[per]
        layouts = []
        for sw, sh in ((min(w, h), max(w, h)), (max(w, h), min(w, h))):
            if ctx.opt("orientation", "auto") == "portrait" and sw > sh:
                continue
            if ctx.opt("orientation", "auto") == "landscape" and sw < sh:
                continue
            for cols, rows in ((a, b), (b, a)):
                cw = (sw - 2 * margin - (cols - 1) * gap) / cols
                ch = (sh - 2 * margin - (rows - 1) * gap) / rows
                scale = min(cw / first.width, ch / first.height)
                layouts.append((scale, sw, sh, cols, rows, cw, ch))
        _, sw, sh, cols, rows, cw, ch = max(layouts)
        out = fitz.open()
        for start in range(0, src.page_count, per):
            ctx.progress(start / src.page_count, "Arranging pages")
            page = out.new_page(width=sw, height=sh)
            for k, pno in enumerate(range(start, min(start + per, src.page_count))):
                col, row = (k % cols, k // cols) if order == "rows" else (k // rows, k % rows)
                x = margin + col * (cw + gap)
                y = margin + row * (ch + gap)
                _place(page, fitz.Rect(x, y, x + cw, y + ch), src, pno, border)
        ctx.save_pdf(out, f"{inp.stem}_{per}up.pdf")
    ctx.extra["note"] = f"{per} pages per sheet. Links and form fields are not carried over to the new layout."


# -------------------------------------------------------------- booklet
def booklet_order(count):
    """Sheet sides for saddle-stitch printing: [(left, right), ...] with None = blank."""
    n = math.ceil(count / 4) * 4
    pages = list(range(count)) + [None] * (n - count)
    sides = []
    for i in range(n // 4):
        sides.append((pages[n - 1 - 2 * i], pages[2 * i]))          # front
        sides.append((pages[2 * i + 1], pages[n - 2 - 2 * i]))      # back
    return sides


@tool("booklet_pdf", zip_name="pdfplume_booklet.zip")
def booklet_pdf(ctx):
    right_bound = ctx.opt("binding", "left") == "right"
    margin = clamp(to_float(ctx.opt("margin"), 5), 0, 30) * MM
    for inp in ctx.inputs:
        src = ctx.open_pdf(inp)
        first = src[0].rect
        if ctx.opt("sheet", "same") == "same":
            sw, sh = first.width * 2, first.height
        else:
            w, h = _sheet(ctx.opt("sheet"), first)
            sw, sh = max(w, h), min(w, h)
        out = fitz.open()
        sides = booklet_order(src.page_count)
        for i, (left, right) in enumerate(sides):
            ctx.progress(i / len(sides), "Imposing booklet")
            if right_bound:
                left, right = right, left
            page = out.new_page(width=sw, height=sh)
            half = sw / 2
            for pno, x0 in ((left, 0), (right, half)):
                if pno is not None:
                    _place(page, fitz.Rect(x0 + margin, margin, x0 + half - margin, sh - margin), src, pno)
        ctx.save_pdf(out, f"{inp.stem}_booklet.pdf")
        ctx.extra["sheets"] = len(sides) // 2
    ctx.extra["note"] = ("Print double-sided and flip on the short edge, then stack the sheets, "
                         "fold them in the middle and staple along the fold.")


# --------------------------------------------------------------- resize
@tool("resize_pdf", zip_name="pdfplume_resized.zip")
def resize_pdf(ctx):
    size = ctx.opt("size", "a4")
    if size == "custom":
        w = clamp(to_float(ctx.opt("width_mm"), 210), 20, 5000) * MM
        h = clamp(to_float(ctx.opt("height_mm"), 297), 20, 5000) * MM
        base = (w, h)
    elif size in SHEETS:
        base = (SHEETS[size].width, SHEETS[size].height)
    else:
        raise ToolError("Choose a page size.")
    orientation = ctx.opt("orientation", "auto")
    margin = clamp(to_float(ctx.opt("margin"), 0), 0, 60) * MM
    scale_content = ctx.opt("mode", "fit") == "fit"
    for inp in ctx.inputs:
        src = ctx.open_pdf(inp)
        out = fitz.open()
        for sp in src:
            ctx.progress(sp.number / src.page_count, "Resizing pages")
            pw, ph = sp.rect.width, sp.rect.height
            w, h = min(base), max(base)
            if orientation == "landscape" or (orientation == "auto" and pw > ph):
                w, h = h, w
            page = out.new_page(width=w, height=h)
            area = page.rect + (margin, margin, -margin, -margin)
            if scale_content:
                target = _fit(area, pw, ph)
            else:  # keep the original scale and centre it (crops if it is larger)
                x, y = (w - pw) / 2, (h - ph) / 2
                target = fitz.Rect(x, y, x + pw, y + ph)
            page.show_pdf_page(target, src, sp.number, keep_proportion=True, clip=None)
        ctx.save_pdf(out, f"{inp.stem}_{size}.pdf")
    ctx.extra["note"] = "Links and form fields are not carried over to resized pages."


# ------------------------------------------------------------- grayscale
@tool("grayscale_pdf", zip_name="pdfplume_grayscale.zip")
def grayscale_pdf(ctx):
    for inp in ctx.inputs:
        ctx.progress(0.1, f"Converting {inp.name}", force=True)
        doc = ctx.open_pdf(inp)
        try:
            doc.recolor(1)  # text, vector graphics and images -> DeviceGray
        except Exception:
            doc.close()
            if not engines.ghostscript_path():
                raise ToolError("This PDF could not be converted to grayscale.")
            out = ctx.output_path(f"{inp.stem}_grayscale.pdf")
            engines.ghostscript(["-sDEVICE=pdfwrite", "-sColorConversionStrategy=Gray",
                                 "-dProcessColorModel=/DeviceGray", "-dAutoRotatePages=/None",
                                 f"-sOutputFile={out}", str(ctx.decrypted_path(inp))])
            ctx.add_output(out)
            continue
        ctx.save_pdf(doc, f"{inp.stem}_grayscale.pdf", garbage=4)
