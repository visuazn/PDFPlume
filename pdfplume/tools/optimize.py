"""Optimize PDF: compress, repair, OCR."""

import shutil

import pymupdf as fitz

from .. import engines
from ..utils import human_size, to_bool, to_float, to_int
from . import ToolError, tool

COMPRESSION_LEVELS = {
    # name: (ghostscript preset, image dpi threshold, target dpi, jpeg quality)
    "extreme": ("/screen", 100, 72, 35),
    "recommended": ("/ebook", 170, 144, 62),
    "low": ("/printer", 320, 240, 82),
}
# Image settings tried in order when compressing to a target size (gentlest first).
TARGET_LADDER = [(320, 240, 85), (220, 170, 75), (170, 144, 62), (150, 120, 52),
                 (120, 96, 42), (100, 72, 34), (80, 60, 26), (70, 50, 20)]


def _compress_with_mupdf(ctx, inp, images, out_path, scrub=False):
    """Re-encode images with ``images`` = (dpi threshold, target dpi, quality)."""
    threshold, target, quality = images
    doc = ctx.open_pdf(inp)
    try:
        doc.rewrite_images(dpi_threshold=threshold, dpi_target=target, quality=quality,
                           lossy=True, lossless=True, bitonal=True, color=True, gray=True)
    except Exception:
        pass
    try:
        doc.subset_fonts()
    except Exception:
        pass
    if scrub:
        try:
            doc.scrub(metadata=False, xml_metadata=False, attached_files=False,
                      embedded_files=False, javascript=False, remove_links=False,
                      reset_fields=False, hidden_text=False, redactions=False,
                      clean_pages=True, thumbnails=True, reset_responses=False)
        except Exception:
            pass
    doc.save(out_path, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True,
             clean=True, use_objstms=1)
    is_form = doc.is_form_pdf
    doc.close()
    return is_form


def _compress_with_ghostscript(ctx, inp, preset, out_path):
    src = ctx.decrypted_path(inp)
    engines.ghostscript([
        "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", f"-dPDFSETTINGS={preset}",
        "-dDetectDuplicateImages=true", "-dCompressFonts=true", "-dSubsetFonts=true",
        "-dAutoRotatePages=/None", f"-sOutputFile={out_path}", str(src)])


def _ghostscript_candidate(ctx, inp, preset, is_form):
    # Ghostscript recompresses more aggressively but flattens form fields.
    if not engines.ghostscript_path() or is_form:
        return None
    path = ctx.work_path(f"{inp.stem}_gs.pdf")
    try:
        _compress_with_ghostscript(ctx, inp, preset, path)
        with fitz.open(path) as check:
            return path if check.page_count else None
    except engines.EngineError:
        return None
    except RuntimeError:
        return None


def _by_level(ctx, inp, level, step):
    preset, threshold, target, quality = COMPRESSION_LEVELS[level]
    mu_path = ctx.work_path(f"{inp.stem}_mu.pdf")
    is_form = _compress_with_mupdf(ctx, inp, (threshold, target, quality), mu_path,
                                   scrub=level == "extreme")
    step(0.5)
    candidates = [mu_path, _ghostscript_candidate(ctx, inp, preset, is_form)]
    return min((c for c in candidates if c), key=lambda p: p.stat().st_size)


def _by_target(ctx, inp, limit, step):
    """Gentlest compression whose result fits under ``limit`` bytes."""
    tried = []
    is_form = False
    for i, images in enumerate(TARGET_LADDER):
        step(i / (len(TARGET_LADDER) + 1))
        path = ctx.work_path(f"{inp.stem}_t{i}.pdf")
        is_form = _compress_with_mupdf(ctx, inp, images, path, scrub=i >= 5)
        tried.append(path)
        if path.stat().st_size <= limit:
            return path, True
    gs = _ghostscript_candidate(ctx, inp, "/screen", is_form)
    if gs:
        tried.append(gs)
    best = min(tried, key=lambda p: p.stat().st_size)
    return best, best.stat().st_size <= limit


@tool("compress_pdf", zip_name="pdfplume_compressed.zip")
def compress_pdf(ctx):
    mode = ctx.opt("mode", "level")
    level = ctx.opt("level", "recommended")
    if level not in COMPRESSION_LEVELS:
        level = "recommended"
    limit = max(0.05, to_float(ctx.opt("target_mb"), 2)) * 1024 * 1024
    total_before = total_after = 0
    missed = []
    n = len(ctx.inputs)
    for i, inp in enumerate(ctx.inputs):
        ctx.progress(i / n, f"Compressing {inp.name}", force=True)
        step = lambda f, i=i, inp=inp: ctx.progress((i + f) / n, f"Compressing {inp.name}")  # noqa: E731
        before = inp.path.stat().st_size
        if mode == "target":
            if before <= limit:
                best, fits = ctx.decrypted_path(inp), True
            else:
                best, fits = _by_target(ctx, inp, limit, step)
            if not fits:
                missed.append(inp.name)
        else:
            best = _by_level(ctx, inp, level, step)
        out = ctx.output_path(f"{inp.stem}_compressed.pdf")
        if best.stat().st_size >= before:
            # Never hand back a bigger file than the user gave us.
            shutil.copyfile(ctx.decrypted_path(inp), out)
        else:
            shutil.copyfile(best, out)
        ctx.add_output(out)
        total_before += before
        total_after += out.stat().st_size
    saved = max(0, total_before - total_after)
    ctx.extra.update({
        "before": total_before, "after": total_after,
        "saved_percent": round(100 * saved / total_before) if total_before else 0,
        "summary": f"{human_size(total_before)} → {human_size(total_after)}",
        "engine": "ghostscript+mupdf" if engines.ghostscript_path() else "mupdf",
    })
    if mode == "target":
        ctx.extra["target"] = human_size(limit)
        if missed:
            ctx.extra["note"] = (f"Couldn’t get {', '.join(missed)} under {human_size(limit)}; this is the "
                                 "smallest version possible. Text and vector graphics can’t shrink much further.")
        else:
            ctx.extra["note"] = f"Every file is now under {human_size(limit)}."


@tool("repair_pdf", zip_name="pdfplume_repaired.zip")
def repair_pdf(ctx):
    import pikepdf
    notes = []
    for inp in ctx.inputs:
        out = ctx.output_path(f"{inp.stem}_repaired.pdf")
        done = False
        # 1) qpdf (via pikepdf) rebuilds broken cross reference tables and streams.
        try:
            with pikepdf.open(inp.path, password=inp.password or "",
                              attempt_recovery=True) as pdf:
                pdf.remove_unreferenced_resources()
                pdf.save(out, fix_metadata_version=True)
            check = fitz.open(out)
            done = check.page_count > 0
            check.close()
        except pikepdf.PasswordError:
            raise ToolError(f"'{inp.name}' is password protected. Enter the password first.")
        except Exception:
            done = False
        # 2) MuPDF's own repair, which recovers objects even without an xref.
        if not done:
            try:
                doc = fitz.open(inp.path)
                if doc.needs_pass:
                    doc.authenticate(inp.password or "")
                if doc.page_count == 0:
                    raise ValueError("no pages")
                doc.save(out, garbage=4, deflate=True, clean=True)
                doc.close()
                done = True
            except Exception:
                done = False
        # 3) Ghostscript re-interprets the whole file as a last resort.
        if not done and engines.ghostscript_path():
            try:
                engines.ghostscript(["-sDEVICE=pdfwrite", f"-sOutputFile={out}", str(inp.path)])
                done = fitz.open(out).page_count > 0
            except Exception:
                done = False
        if not done:
            raise ToolError(f"'{inp.name}' is too badly damaged to be recovered.")
        try:
            was_broken = fitz.open(inp.path).is_repaired
        except Exception:
            was_broken = True
        notes.append({"file": inp.name, "had_errors": bool(was_broken)})
        ctx.add_output(out)
    ctx.extra["files"] = notes


# ---------------------------------------------------------------------------- OCR
def page_needs_ocr(page):
    return len(page.get_text("text").strip()) < 10


def ocr_document(doc, lang="eng", dpi=300, progress=None, skip_text_pages=True, work_dir=None):
    """Add an invisible, searchable text layer to every scanned page of ``doc``.

    Uses Tesseract's text-only PDF renderer and overlays the result on the
    original page, so the page itself (vector text, images) is not altered.
    """
    import tempfile
    from pathlib import Path

    if not engines.tesseract_path():
        raise ToolError("OCR needs Tesseract, which is not installed. See the README "
                        "('Optional engines') for a one-line install command.")
    available = set(engines.tesseract_languages())
    langs = [lang_ for lang_ in str(lang or "eng").replace(",", "+").split("+") if lang_]
    missing = [lang_ for lang_ in langs if available and lang_ not in available]
    if missing:
        raise ToolError(f"Tesseract language data not installed: {', '.join(missing)}.")
    lang = "+".join(langs) or "eng"
    processed = 0
    total = doc.page_count
    with tempfile.TemporaryDirectory(dir=work_dir) as tmp:
        for page in doc:
            if progress:
                progress(page.number / max(total, 1), f"Recognizing text on page {page.number + 1}")
            if skip_text_pages and not page_needs_ocr(page):
                continue
            if page.rotation:
                page.remove_rotation()
            r = page.rect
            # Keep very large pages to a sane pixel count.
            page_dpi = dpi
            while (r.width / 72 * page_dpi) * (r.height / 72 * page_dpi) > 45e6 and page_dpi > 100:
                page_dpi -= 25
            pix = page.get_pixmap(dpi=page_dpi, colorspace=fitz.csGRAY, alpha=False)
            img = Path(tmp) / f"p{page.number}.png"
            pix.save(str(img))
            pdf_bytes = engines.tesseract_pdf(img, lang, page_dpi)
            text_layer = fitz.open("pdf", pdf_bytes)
            page.show_pdf_page(page.rect, text_layer, 0, keep_proportion=False, overlay=True)
            text_layer.close()
            processed += 1
    return processed


@tool("ocr_pdf", zip_name="pdfplume_ocr.zip")
def ocr_pdf(ctx):
    lang = ctx.opt("language", "eng")
    if isinstance(lang, list):
        lang = "+".join(lang)
    skip = not to_bool(ctx.opt("force"))
    dpi = max(150, min(to_int(ctx.opt("dpi"), 300), 600))
    total_pages = 0
    n = len(ctx.inputs)
    for i, inp in enumerate(ctx.inputs):
        doc = ctx.open_pdf(inp)
        count = ocr_document(
            doc, lang, dpi, skip_text_pages=skip, work_dir=ctx.work_dir,
            progress=lambda f, m, i=i: ctx.progress((i + f) / n, m))
        total_pages += count
        ctx.save_pdf(doc, f"{inp.stem}_ocr.pdf", garbage=3)
    ctx.extra["pages_recognized"] = total_pages
    if total_pages == 0:
        ctx.extra["note"] = ("All pages already contained selectable text. Enable "
                             "'Re-run OCR on all pages' to force recognition.")
