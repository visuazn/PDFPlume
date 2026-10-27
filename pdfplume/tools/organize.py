"""Organize PDF: merge, split, remove / extract pages, organize, rotate."""

import pymupdf as fitz

from ..utils import parse_page_ranges, to_bool, to_int
from . import ToolError, tool


def _rotate_page(page, delta):
    if delta % 360:
        page.set_rotation((page.rotation + int(delta)) % 360)


@tool("merge_pdf", min_files=2)
def merge_pdf(ctx):
    out = fitz.open()
    toc = []
    n = len(ctx.inputs)
    for i, inp in enumerate(ctx.inputs):
        ctx.progress(i / n, f"Merging {inp.name}")
        src = ctx.open_pdf(inp)
        start = out.page_count
        out.insert_pdf(src)
        rot = to_int(inp.options.get("rotation"))
        for pno in range(start, out.page_count):
            _rotate_page(out[pno], rot)
        try:
            for lvl, title, page in src.get_toc(simple=True):
                toc.append([lvl, title, page + start if page > 0 else -1])
        except Exception:
            pass
        src.close()
    if toc:
        try:
            out.set_toc(toc)
        except Exception:
            pass
    name = ctx.opt("filename") or "merged.pdf"
    ctx.save_pdf(out, name if name.lower().endswith(".pdf") else name + ".pdf")


def _write_subset(ctx, src, pages, filename):
    doc = fitz.open()
    for p in pages:
        doc.insert_pdf(src, from_page=p, to_page=p)
    path = ctx.save_pdf(doc, filename)
    doc.close()
    return path


def _range_label(pages):
    if not pages:
        return ""
    if pages == list(range(pages[0], pages[-1] + 1)) and len(pages) > 1:
        return f"{pages[0] + 1}-{pages[-1] + 1}"
    if len(pages) == 1:
        return str(pages[0] + 1)
    return f"{pages[0] + 1}-{pages[-1] + 1}"


@tool("split_pdf", zip_name="pdfplume_split.zip")
def split_pdf(ctx):
    mode = ctx.opt("mode", "ranges")
    for idx, inp in enumerate(ctx.inputs):
        src = ctx.open_pdf(inp)
        count = src.page_count
        groups = []
        merge = False
        if mode == "ranges":
            ranges = ctx.opt("ranges") or []
            if not ranges:
                raise ToolError("Add at least one page range.")
            for r in ranges:
                a = to_int(r.get("from"), 1)
                b = to_int(r.get("to"), count)
                if a < 1 or b > count or a > b:
                    raise ToolError(f"Range {a}-{b} is not valid for '{inp.name}' "
                                    f"({count} pages).")
                groups.append(list(range(a - 1, b)))
            merge = to_bool(ctx.opt("merge"))
        elif mode == "fixed":
            size = max(1, to_int(ctx.opt("every"), 1))
            groups = [list(range(s, min(s + size, count))) for s in range(0, count, size)]
        elif mode == "all":
            groups = [[p] for p in range(count)]
        elif mode == "select":
            pages = parse_page_ranges(ctx.opt("pages", ""), count)
            if to_bool(ctx.opt("merge"), True):
                groups = [pages]
            else:
                groups = [[p] for p in pages]
        elif mode == "size":
            limit = max(0.05, float(ctx.opt("max_mb", 1))) * 1024 * 1024
            sizes = []
            for p in range(count):
                one = fitz.open()
                one.insert_pdf(src, from_page=p, to_page=p)
                sizes.append(len(one.tobytes(garbage=3, deflate=True)))
                one.close()
                ctx.progress(0.5 * p / count, "Measuring pages")
            current, total = [], 0
            for p, s in enumerate(sizes):
                if current and total + s > limit:
                    groups.append(current)
                    current, total = [], 0
                current.append(p)
                total += s
            if current:
                groups.append(current)
        else:
            raise ToolError("Unknown split mode.")

        if merge:
            pages = [p for g in groups for p in g]
            _write_subset(ctx, src, pages, f"{inp.stem}_merged_ranges.pdf")
        else:
            for gi, pages in enumerate(groups):
                ctx.progress((idx + gi / max(len(groups), 1)) / len(ctx.inputs), "Splitting")
                _write_subset(ctx, src, pages, f"{inp.stem}_{_range_label(pages)}.pdf")
        src.close()
    ctx.extra["files_created"] = len(ctx.outputs)


@tool("remove_pages")
def remove_pages(ctx):
    for inp in ctx.inputs:
        doc = ctx.open_pdf(inp)
        spec = inp.options.get("pages") or ctx.opt("pages", "")
        pages = sorted(set(parse_page_ranges(spec, doc.page_count)))
        if len(pages) >= doc.page_count:
            raise ToolError("You can't remove every page of a document.")
        doc.delete_pages(pages)
        ctx.save_pdf(doc, f"{inp.stem}_removed.pdf")
        ctx.extra["removed"] = len(pages)


@tool("extract_pages")
def extract_pages(ctx):
    separate = to_bool(ctx.opt("separate"))
    for inp in ctx.inputs:
        src = ctx.open_pdf(inp)
        spec = inp.options.get("pages") or ctx.opt("pages", "")
        pages = parse_page_ranges(spec, src.page_count)
        if separate:
            for p in pages:
                _write_subset(ctx, src, [p], f"{inp.stem}_page_{p + 1}.pdf")
        else:
            _write_subset(ctx, src, pages, f"{inp.stem}_extracted.pdf")


@tool("organize_pdf")
def organize_pdf(ctx):
    """``options.pages``: ordered list of {file, page, rotation}; page None = blank page."""
    layout = ctx.opt("pages") or []
    sources = {}
    out = fitz.open()
    if not layout:
        raise ToolError("There are no pages left in the document.")
    for i, entry in enumerate(layout):
        ctx.progress(i / len(layout), "Organizing pages")
        rot = to_int(entry.get("rotation"))
        page = entry.get("page")
        if page is None or entry.get("blank"):
            ref = out[-1].rect if out.page_count else fitz.paper_rect("a4")
            new = out.new_page(width=ref.width, height=ref.height)
            _rotate_page(new, rot)
            continue
        fi = to_int(entry.get("file"))
        if fi < 0 or fi >= len(ctx.inputs):
            raise ToolError("Invalid page reference.")
        if fi not in sources:
            sources[fi] = ctx.open_pdf(ctx.inputs[fi])
        src = sources[fi]
        page = to_int(page)
        if page < 0 or page >= src.page_count:
            raise ToolError("Invalid page reference.")
        out.insert_pdf(src, from_page=page, to_page=page)
        _rotate_page(out[-1], rot)
    name = ctx.inputs[0].stem + "_organized.pdf"
    ctx.save_pdf(out, name)


@tool("rotate_pdf", zip_name="pdfplume_rotated.zip")
def rotate_pdf(ctx):
    """Per file: ``options.rotation`` (all pages) and ``options.pages`` {index: degrees}."""
    for inp in ctx.inputs:
        doc = ctx.open_pdf(inp)
        all_rot = to_int(inp.options.get("rotation", ctx.opt("rotation", 0)))
        per_page = inp.options.get("pages") or {}
        for page in doc:
            delta = all_rot + to_int(per_page.get(str(page.number), 0))
            _rotate_page(page, delta)
        ctx.save_pdf(doc, f"{inp.stem}_rotated.pdf")
