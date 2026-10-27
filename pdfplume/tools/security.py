"""PDF security: unlock, protect, sign, redact, compare."""

import difflib
import html
import re
import shutil
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageChops

from ..utils import clamp, parse_color, to_bool, to_float
from . import ToolError, tool
from .edit import apply_elements


# --------------------------------------------------------------------- unlock
@tool("unlock_pdf", zip_name="pdfplume_unlocked.zip")
def unlock_pdf(ctx):
    import pikepdf
    for inp in ctx.inputs:
        password = inp.password or ctx.opt("password", "")
        try:
            pdf = pikepdf.open(inp.path, password=password)
        except pikepdf.PasswordError:
            raise ToolError(f"'{inp.name}' needs its password to be unlocked. "
                            "Enter the correct password.")
        except Exception:
            raise ToolError(f"'{inp.name}' could not be opened.")
        with pdf:
            was_encrypted = pdf.is_encrypted
            out = ctx.output_path(f"{inp.stem}_unlocked.pdf")
            pdf.save(out)
        ctx.add_output(out)
        if not was_encrypted:
            ctx.extra["note"] = "This file had no protection - a copy was returned."


# -------------------------------------------------------------------- protect
@tool("protect_pdf", zip_name="pdfplume_protected.zip")
def protect_pdf(ctx):
    import pikepdf
    password = str(ctx.opt("password", ""))
    if len(password) < 1:
        raise ToolError("Enter a password to protect your PDF.")
    if ctx.opt("confirm") is not None and str(ctx.opt("confirm")) != password:
        raise ToolError("The passwords do not match.")
    owner = str(ctx.opt("owner_password") or password)
    allow_print = to_bool(ctx.opt("allow_print"), True)
    allow_copy = to_bool(ctx.opt("allow_copy"), True)
    allow_modify = to_bool(ctx.opt("allow_modify"), True)
    permissions = pikepdf.Permissions(
        accessibility=True, extract=allow_copy, modify_annotation=allow_modify,
        modify_assembly=allow_modify, modify_form=allow_modify, modify_other=allow_modify,
        print_lowres=allow_print, print_highres=allow_print)
    for inp in ctx.inputs:
        src = ctx.decrypted_path(inp)
        with pikepdf.open(src) as pdf:
            out = ctx.output_path(f"{inp.stem}_protected.pdf")
            pdf.save(out, encryption=pikepdf.Encryption(user=password, owner=owner, R=6,
                                                         allow=permissions))
        ctx.add_output(out)


# ----------------------------------------------------------------------- sign
@tool("sign_pdf", max_files=1)
def sign_pdf(ctx):
    elements = ctx.opt("elements") or []
    digital = ctx.opt("digital") or {}
    cert_path = digital.get("cert_path") if isinstance(digital, dict) else None
    if not cert_path and not any(e.get("type") in ("image", "text") for e in elements):
        raise ToolError("Place your signature on the document first.")
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    keep_sigs = doc.get_sigflags() > 0 and not doc.is_encrypted
    if cert_path and doc.is_encrypted:
        raise ToolError("Password-protected PDFs can't be signed digitally. Unlock the PDF first, "
                        "then sign it.")
    if cert_path or keep_sigs:
        # Work on a copy saved incrementally, so signatures already in the file stay valid.
        doc.close()
        work = ctx.work_path("to_sign.pdf")
        shutil.copyfile(inp.path, work)
        doc = fitz.open(work)
    apply_elements(doc, elements, ctx.progress)
    signer = str(ctx.opt("signer_name") or "").strip()
    if signer:
        meta = doc.metadata or {}
        meta["keywords"] = (meta.get("keywords") or "") + f" Signed by {signer}"
        doc.set_metadata(meta)
    if not cert_path:
        if keep_sigs and doc.can_save_incrementally():
            doc.save(doc.name, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP, deflate=True)
            doc.close()
            out = ctx.output_path(f"{inp.stem}_signed.pdf")
            shutil.move(work, out)
            ctx.add_output(out)
            ctx.extra["note"] = "Saved as an update to the file, so its existing digital signatures stay valid."
        else:
            ctx.save_pdf(doc, f"{inp.stem}_signed.pdf")
        return
    _sign_digitally(ctx, doc, work, inp, elements, digital, cert_path)


def _signature_box(doc, elements):
    """The first placed signature image, as (page, box in PDF user space)."""
    for el in elements:
        if el.get("type") != "image":
            continue
        pno = int(el.get("page") or 0)
        if not 0 <= pno < doc.page_count:
            continue
        page = doc[pno]
        W, H = page.rect.width, page.rect.height  # pages with elements were un-rotated
        x, y = float(el.get("x") or 0), float(el.get("y") or 0)
        r = fitz.Rect(x * W, y * H, (x + float(el.get("w") or 0)) * W, (y + float(el.get("h") or 0)) * H)
        r = (r * ~page.transformation_matrix).normalize()
        return pno, (round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2))
    return 0, None


def _sign_digitally(ctx, doc, tmp, inp, elements, digital, cert_path):
    from .. import certs
    ctx.progress(0.85, "Signing with your certificate", force=True)
    page, box = _signature_box(doc, elements)
    if elements or ctx.opt("signer_name"):
        if doc.can_save_incrementally():
            doc.save(doc.name, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP, deflate=True)
        elif doc.get_sigflags() > 0:
            raise ToolError("This PDF is damaged, so it can't be changed without breaking its existing "
                            "signatures. Sign it without adding new fields.")
        else:
            fixed = ctx.work_path("to_sign_fixed.pdf")
            doc.save(fixed, garbage=3, deflate=True)
            tmp = fixed
    doc.close()
    out = ctx.output_path(f"{inp.stem}_signed.pdf")
    try:
        who = certs.sign_pdf_file(tmp, out, cert_path, str(digital.get("password") or ""),
                                  reason=str(digital.get("reason") or "")[:200],
                                  location=str(digital.get("location") or "")[:200],
                                  contact=str(digital.get("contact") or "")[:200], box=box, page=page)
    except certs.CertError as exc:
        out.unlink(missing_ok=True)
        raise ToolError(str(exc))
    ctx.add_output(out)
    try:  # the signer's own certificate counts as trusted when checking the result
        from pyhanko.keys import load_cert_from_pemder
        own = [load_cert_from_pemder(str(Path(cert_path).with_suffix(".pem")))]
    except Exception:
        own = []
    ctx.extra["digital"] = {"signer": who, "signatures": certs.verify_pdf(out, trusted=own)}


# --------------------------------------------------------------------- redact
PATTERNS = {
    "email": r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",
    "phone": r"(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w])",
    "url": r"(?:https?://|www\.)[^\s]+",
    "credit_card": r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)",
    "date": r"\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b",
    "ssn": r"\b\d{3}-\d{2}-\d{4}\b",
    "iban": r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b",
    "ip": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
}


def visible_frac(page, rect):
    r = fitz.Rect(rect) * page.rotation_matrix
    r.normalize()
    W, H = page.rect.width or 1, page.rect.height or 1
    return [round(r.x0 / W, 5), round(r.y0 / H, 5), round(r.x1 / W, 5), round(r.y1 / H, 5)]


def find_matches(doc, terms, patterns, case_sensitive=False, whole_words=False):
    """Locate words/phrases and pattern matches. Rects are in page coordinates."""
    regexes = []
    for term in terms:
        term = str(term).strip()
        if not term:
            continue
        body = re.escape(term)
        if whole_words:
            body = rf"(?<!\w){body}(?!\w)"
        regexes.append(re.compile(body, 0 if case_sensitive else re.IGNORECASE))
    for name in patterns:
        if name in PATTERNS:
            regexes.append(re.compile(PATTERNS[name]))
        elif str(name).startswith("re:"):
            try:
                regexes.append(re.compile(str(name)[3:]))
            except re.error:
                raise ToolError(f"Invalid regular expression: {name[3:]}")
    results = []
    if not regexes:
        return results
    for page in doc:
        text = page.get_text("text")
        found = set()
        for rx in regexes:
            for m in rx.finditer(text):
                s = m.group(0).strip()
                if s and "\n" not in s:
                    found.add(s)
        for s in sorted(found, key=len, reverse=True):
            for quad in page.search_for(s, quads=True):
                rect = quad.rect
                if case_sensitive and s not in page.get_textbox(rect + (-1, -1, 1, 1)):
                    continue
                results.append({"page": page.number, "text": s, "rect": rect,
                                "frac": visible_frac(page, rect)})
    return results


@tool("redact_pdf", max_files=1)
def redact_pdf(ctx):
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    fill = parse_color(ctx.opt("fill", "#000000"))
    count = 0
    for area in ctx.opt("areas") or []:
        pno = int(area.get("page", -1))
        if not 0 <= pno < doc.page_count:
            continue
        page = doc[pno]
        W, H = page.rect.width, page.rect.height
        visible = fitz.Rect(clamp(to_float(area.get("x0")), 0, 1) * W,
                            clamp(to_float(area.get("y0")), 0, 1) * H,
                            clamp(to_float(area.get("x1")), 0, 1) * W,
                            clamp(to_float(area.get("y1")), 0, 1) * H)
        page.add_redact_annot((visible * page.derotation_matrix).normalize(), fill=fill)
        count += 1
    matches = find_matches(doc, ctx.opt("terms") or [], ctx.opt("patterns") or [],
                           case_sensitive=to_bool(ctx.opt("case_sensitive")),
                           whole_words=to_bool(ctx.opt("whole_words")))
    for m in matches:
        doc[m["page"]].add_redact_annot(m["rect"], fill=fill)
        count += 1
    if count == 0:
        raise ToolError("Nothing to redact: mark areas or enter words to search for.")
    for page in doc:
        ctx.progress(page.number / doc.page_count, "Removing content")
        if page.first_annot:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
    if to_bool(ctx.opt("remove_metadata"), True):
        doc.set_metadata({})
        doc.del_xml_metadata()
    ctx.extra["redactions"] = count
    ctx.save_pdf(doc, f"{inp.stem}_redacted.pdf", garbage=4)


# -------------------------------------------------------------------- compare
def _doc_words(doc):
    words = []
    for page in doc:
        for w in page.get_text("words", sort=True):
            words.append((page.number, fitz.Rect(w[:4]), w[4]))
    return words


def _merge_rects(items):
    """Join word boxes on the same line into one highlight box per run."""
    merged = []
    for page, rect in items:
        if merged and merged[-1][0] == page:
            last = merged[-1][1]
            same_line = abs(last.y0 - rect.y0) < 2 and abs(last.y1 - rect.y1) < 2
            if same_line and -2 < rect.x0 - last.x1 < 12:
                merged[-1] = (page, last | rect)
                continue
        merged.append((page, fitz.Rect(rect)))
    return merged


def _norm(word, ignore_case):
    w = word.strip(".,;:!?\"'()[]{}") or word
    return w.lower() if ignore_case else w


COLORS = {"del": (0.93, 0.22, 0.22), "ins": (0.13, 0.7, 0.3), "chg": (0.98, 0.6, 0.1)}


def _compare_text(ctx, a_inp, b_inp, A, B):
    ignore_case = to_bool(ctx.opt("ignore_case"))
    wa, wb = _doc_words(A), _doc_words(B)
    ta = [_norm(w[2], ignore_case) for w in wa]
    tb = [_norm(w[2], ignore_case) for w in wb]
    ctx.progress(0.2, "Comparing text", force=True)
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    hi_a, hi_b, changes = [], [], []
    stats = {"inserted": 0, "deleted": 0, "changed": 0}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        kind = {"replace": "chg", "delete": "del", "insert": "ins"}[tag]
        stats[{"chg": "changed", "del": "deleted", "ins": "inserted"}[kind]] += 1
        ra = _merge_rects([(wa[k][0], wa[k][1]) for k in range(i1, i2)])
        rb = _merge_rects([(wb[k][0], wb[k][1]) for k in range(j1, j2)])
        idx = len(changes)
        for page, rect in ra:
            hi_a.append({"page": page, "rect": rect, "kind": kind, "change": idx})
        for page, rect in rb:
            hi_b.append({"page": page, "rect": rect, "kind": kind, "change": idx})
        changes.append({
            "kind": kind,
            "a": " ".join(w[2] for w in wa[i1:i2])[:300],
            "b": " ".join(w[2] for w in wb[j1:j2])[:300],
            "a_page": wa[i1][0] if i2 > i1 else (wa[i1 - 1][0] if i1 else 0),
            "b_page": wb[j1][0] if j2 > j1 else (wb[j1 - 1][0] if j1 else 0),
        })

    # Annotated side-by-side report.
    ctx.progress(0.6, "Building report", force=True)
    report = fitz.open()
    gap = 24
    pages = max(A.page_count, B.page_count)
    summary = report.new_page(width=842, height=595)
    lines = [f"Comparison: {a_inp.name}  vs  {b_inp.name}",
             f"{stats['changed']} changed, {stats['deleted']} removed, "
             f"{stats['inserted']} added passages.", ""]
    for c in changes[:60]:
        if c["kind"] == "del":
            lines.append(f"- [page {c['a_page'] + 1}] removed: {c['a'][:110]}")
        elif c["kind"] == "ins":
            lines.append(f"+ [page {c['b_page'] + 1}] added: {c['b'][:110]}")
        else:
            lines.append(f"~ [page {c['a_page'] + 1}] '{c['a'][:50]}' -> '{c['b'][:50]}'")
    if len(changes) > 60:
        lines.append(f"... and {len(changes) - 60} more differences")
    summary.insert_htmlbox(summary.rect + (36, 36, -36, -36),
                           "".join(f"<p>{html.escape(line)}</p>" for line in lines),
                           css="*{font-family:sans-serif;font-size:9px} p{margin:0 0 2px 0}")
    for i in range(pages):
        pa = A[i] if i < A.page_count else None
        pb = B[i] if i < B.page_count else None
        wa_ = pa.rect.width if pa else pb.rect.width
        wb_ = pb.rect.width if pb else pa.rect.width
        h = max(pa.rect.height if pa else 0, pb.rect.height if pb else 0)
        page = report.new_page(width=wa_ + wb_ + gap, height=h + 20)
        for src, x0, hl in ((pa, 0, hi_a), (pb, wa_ + gap, hi_b)):
            if src is None:
                continue
            target = fitz.Rect(x0, 20, x0 + src.rect.width, 20 + src.rect.height)
            page.show_pdf_page(target, src.parent, src.number)
            shape = page.new_shape()
            for item in hl:
                if item["page"] != src.number:
                    continue
                r = (fitz.Rect(item["rect"]) * src.rotation_matrix).normalize()
                shape.draw_rect(r + (x0, 20, x0, 20))
                shape.finish(color=None, fill=COLORS[item["kind"]], fill_opacity=0.35)
            shape.commit()
        page.insert_text((4, 14), a_inp.name[:80], fontsize=9, color=(0.4, 0.4, 0.4))
        page.insert_text((wa_ + gap + 4, 14), b_inp.name[:80], fontsize=9, color=(0.4, 0.4, 0.4))
    ctx.save_pdf(report, "comparison_report.pdf")

    def export(doc, inp, hl):
        return {
            "id": inp.id, "name": inp.name,
            "pages": [{"w": p.rect.width, "h": p.rect.height} for p in doc],
            "highlights": [{"page": h["page"], "kind": h["kind"], "change": h["change"],
                            "rect": visible_frac(doc[h["page"]], h["rect"])} for h in hl[:20000]],
        }

    ctx.extra.update({"mode": "text", "a": export(A, a_inp, hi_a), "b": export(B, b_inp, hi_b),
                      "changes": changes[:3000], "stats": stats,
                      "identical": not changes})


def _compare_overlay(ctx, A, B):
    pages = max(A.page_count, B.page_count)
    report = fitz.open()
    info = []
    for i in range(pages):
        ctx.progress(i / pages, f"Comparing page {i + 1}")
        imgs = []
        for doc in (A, B):
            if i < doc.page_count:
                pix = doc[i].get_pixmap(dpi=110, colorspace=fitz.csGRAY, alpha=False)
                imgs.append(Image.frombytes("L", (pix.width, pix.height), pix.samples))
            else:
                imgs.append(None)
        ref = imgs[0] or imgs[1]
        a = imgs[0] or Image.new("L", ref.size, 255)
        b = (imgs[1] or Image.new("L", ref.size, 255)).resize(a.size)
        overlay = Image.merge("RGB", (b, ImageChops.darker(a, b), a))
        diff = ImageChops.difference(a, b).point(lambda v: 255 if v > 60 else 0)
        changed = sum(diff.histogram()[255:]) / (a.width * a.height)
        name = f"overlay_{i + 1}.png"
        overlay.save(ctx.asset_path(name), "PNG", optimize=True)
        src_rect = (A[i] if i < A.page_count else B[i]).rect
        page = report.new_page(width=src_rect.width, height=src_rect.height)
        page.insert_image(page.rect, filename=str(ctx.asset_path(name)))
        info.append({"asset": name, "changed": round(changed * 100, 2),
                     "w": src_rect.width, "h": src_rect.height})
    ctx.save_pdf(report, "comparison_overlay.pdf")
    ctx.extra.update({"mode": "overlay", "pages": info,
                      "identical": all(p["changed"] == 0 for p in info)})


@tool("compare_pdf", min_files=2, max_files=2)
def compare_pdf(ctx):
    a_inp, b_inp = ctx.inputs
    A, B = ctx.open_pdf(a_inp), ctx.open_pdf(b_inp)
    if ctx.opt("mode", "text") == "overlay":
        _compare_overlay(ctx, A, B)
    else:
        _compare_text(ctx, a_inp, b_inp, A, B)
