"""Fill PDF forms, and edit document properties and bookmarks."""

import pymupdf as fitz

from ..structure import detect_headings, normalize_toc
from ..utils import to_bool
from . import ToolError, tool
from .security import visible_frac

TYPES = {
    fitz.PDF_WIDGET_TYPE_TEXT: "text",
    fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
    fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio",
    fitz.PDF_WIDGET_TYPE_COMBOBOX: "combobox",
    fitz.PDF_WIDGET_TYPE_LISTBOX: "listbox",
    fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
    fitz.PDF_WIDGET_TYPE_BUTTON: "button",
}
READ_ONLY, REQUIRED, MULTILINE, PASSWORD, MULTISELECT = 1, 2, 1 << 12, 1 << 13, 1 << 21


def _on_state(w):
    """Name of a check box / radio button's 'on' appearance."""
    states = (w.button_states() or {}).get("normal") or []
    return next((s for s in states if s != "Off"), None) or "Yes"


def _choices(w):
    out = []
    for c in w.choice_values or []:
        if isinstance(c, (list, tuple)):  # [export value, display text]
            out.append({"value": str(c[0]), "label": str(c[-1])})
        else:
            out.append({"value": str(c), "label": str(c)})
    return out


def list_fields(doc):
    """Every form field widget with its position as fractions of the visible page."""
    fields = []
    for page in doc:
        for w in page.widgets() or []:
            kind = TYPES.get(w.field_type, "other")
            if kind in ("button", "other"):
                continue
            flags = w.field_flags or 0
            value = w.field_value
            if kind == "checkbox":
                value = value not in (False, None, "", "Off")
            elif kind == "radio":
                value = (doc.xref_get_key(w.xref, "AS")[1] or "/Off") != "/Off"
            elif kind == "listbox" and flags & MULTISELECT:
                value = value if isinstance(value, list) else ([value] if value else [])
            else:
                value = "" if value in (None, False) else str(value)
            fields.append({
                "xref": w.xref, "page": page.number, "name": w.field_name or "",
                "label": w.field_label or "", "type": kind, "value": value,
                "rect": visible_frac(page, w.rect), "options": _choices(w) if kind in ("combobox", "listbox") else [],
                "readonly": bool(flags & READ_ONLY), "required": bool(flags & REQUIRED),
                "multiline": bool(flags & MULTILINE), "password": bool(flags & PASSWORD),
                "multiselect": bool(flags & MULTISELECT), "maxlen": w.text_maxlen or 0,
                "font_size": w.text_fontsize or 0,
            })
    return fields


def _set_radio(doc, w, on):
    name = _on_state(w)
    doc.xref_set_key(w.xref, "AS", f"/{name}" if on else "/Off")
    if on:
        kind, parent = doc.xref_get_key(w.xref, "Parent")
        target = int(parent.split()[0]) if kind == "xref" else w.xref
        doc.xref_set_key(target, "V", f"/{name}")


@tool("fill_form", max_files=1)
def fill_form(ctx):
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    values = {str(k): v for k, v in (ctx.opt("values") or {}).items()}
    if not doc.is_form_pdf:
        raise ToolError("This PDF has no fillable form fields. Use Edit PDF to type anywhere on the page.")
    if doc.is_encrypted and not doc.permissions & fitz.PDF_PERM_FORM:
        raise ToolError("The owner of this PDF does not allow filling in its form.")
    filled = 0
    for page in doc:
        ctx.progress(page.number / doc.page_count, "Filling in the form")
        widgets = list(page.widgets() or [])  # keep the page alive while widgets are used
        for w in widgets:
            key = str(w.xref)
            if key not in values or (w.field_flags or 0) & READ_ONLY:
                continue
            v = values[key]
            kind = TYPES.get(w.field_type)
            if kind == "radio":
                _set_radio(doc, w, to_bool(v))
                filled += bool(to_bool(v))
                continue
            if kind == "checkbox":
                w.field_value = _on_state(w) if to_bool(v) else "Off"
            elif kind == "text":
                v = "" if v is None else str(v)
                w.field_value = v[:w.text_maxlen] if w.text_maxlen else v
            elif kind in ("combobox", "listbox"):
                if isinstance(v, list):
                    v = v if (w.field_flags or 0) & MULTISELECT else (v[:1] or [""])[0]
                w.field_value = v if isinstance(v, list) else str(v or "")
            else:
                continue
            w.update()
            filled += 1 if v not in ("", None, False, [], "Off") else 0
    flatten = to_bool(ctx.opt("flatten"))
    if flatten:
        ctx.progress(0.9, "Flattening the form", force=True)
        # MuPDF draws no appearance for list boxes, so write their choice as text.
        lists = [(page.number, w.rect, ", ".join(w.field_value) if isinstance(w.field_value, list) else str(w.field_value or ""),
                  w.text_fontsize or 10)
                 for page in doc for w in page.widgets([fitz.PDF_WIDGET_TYPE_LISTBOX]) if w.field_value]
        doc.bake(annots=False, widgets=True)
        for pno, rect, text, size in lists:
            doc[pno].insert_textbox(rect + (2, 1, -2, 0), text, fontsize=size, fontname="helv")
    else:
        doc.need_appearances(True)  # let viewers redraw values in their own fonts
    ctx.save_pdf(doc, f"{inp.stem}_filled.pdf")
    ctx.extra.update({"filled": filled, "flattened": flatten})


# ------------------------------------------------------- properties & bookmarks
META_KEYS = ("title", "author", "subject", "keywords", "creator", "producer")


def read_outline(doc):
    meta = doc.metadata or {}
    toc = [{"level": lvl, "title": title, "page": page} for lvl, title, page, *_ in doc.get_toc(simple=True)]
    suggested = [{"level": h["level"], "title": h["title"], "page": h["page"] + 1} for h in detect_headings(doc)]
    return {"metadata": {k: meta.get(k) or "" for k in META_KEYS}, "toc": toc, "suggested": suggested,
            "pages": doc.page_count}


def _sync_xmp(path):
    """Copy the Info dictionary into XMP so viewers that prefer XMP agree with it."""
    import pikepdf
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
            xmp.load_from_docinfo(pdf.docinfo, raise_failure=False)
        pdf.save(path)


@tool("edit_metadata", max_files=1)
def edit_metadata(ctx):
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    current = doc.metadata or {}
    new = dict(current)
    for key in META_KEYS:
        if key in (ctx.opt("metadata") or {}):
            new[key] = str(ctx.opt("metadata")[key] or "").strip()[:2000]
    new["modDate"] = fitz.get_pdf_now()
    doc.set_metadata({k: v for k, v in new.items() if k not in ("format", "encryption", "trapped")})
    toc = None
    if ctx.opt("toc") is not None:
        toc = normalize_toc(ctx.opt("toc"), doc.page_count)
        doc.set_toc(toc)
    if to_bool(ctx.opt("open_outline"), True) and toc:
        doc.xref_set_key(doc.pdf_catalog(), "PageMode", "/UseOutlines")
    out = ctx.save_pdf(doc, f"{inp.stem}.pdf")
    try:
        _sync_xmp(out)
    except Exception:
        pass  # the Info dictionary is already updated
    ctx.extra.update({"bookmarks": len(toc) if toc is not None else len(doc.get_toc()),
                      "title": new.get("title") or ""})
