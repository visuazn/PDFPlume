"""Edit PDF: page numbers, watermark, crop, and the visual editor (text, images,
shapes, drawings) that the Edit and Sign tools share."""

import base64
import html
import io
import math

import pymupdf as fitz
from PIL import Image

from ..utils import clamp, parse_color, parse_page_ranges, to_bool, to_float, to_int
from . import ToolError, tool

BASE14 = {
    # family: (regular, bold, italic, bold-italic)
    "helvetica": ("helv", "hebo", "heit", "hebi"),
    "times": ("tiro", "tibo", "tiit", "tibi"),
    "courier": ("cour", "cobo", "coit", "cobi"),
}
CSS_FAMILY = {"helvetica": "sans-serif", "times": "serif", "courier": "monospace"}
POSITIONS = ("top-left", "top-center", "top-right", "middle-left", "middle-center",
             "middle-right", "bottom-left", "bottom-center", "bottom-right")


def base14(family, bold=False, italic=False):
    names = BASE14.get(str(family).lower(), BASE14["helvetica"])
    return names[(1 if bold else 0) + (2 if italic else 0)]


def _pages(ctx, doc, key="pages"):
    spec = ctx.opt(key, "all") or "all"
    return parse_page_ranges(str(spec), doc.page_count)


def _anchor(position, page_rect, box_w, box_h, margin):
    """Top-left corner of a ``box_w`` x ``box_h`` box at a 3x3 grid position."""
    vert, _, horiz = position.partition("-")
    W, H = page_rect.width, page_rect.height
    x = {"left": margin, "center": (W - box_w) / 2, "right": W - margin - box_w}.get(horiz, (W - box_w) / 2)
    y = {"top": margin, "middle": (H - box_h) / 2, "bottom": H - margin - box_h}.get(vert, H - margin - box_h)
    return x, y


def _unrotate(page):
    if page.rotation:
        page.remove_rotation()


# --------------------------------------------------------------- page numbers
@tool("add_page_numbers", zip_name="pdfplume_numbered.zip")
def add_page_numbers(ctx):
    position = ctx.opt("position", "bottom-center")
    if position not in POSITIONS:
        position = "bottom-center"
    margin = {"small": 18, "recommended": 30, "big": 54}.get(ctx.opt("margin"), 30)
    first = to_int(ctx.opt("first_number"), 1)
    fmt = ctx.opt("format", "{n}") or "{n}"
    if fmt == "custom":
        fmt = ctx.opt("custom_text", "{n}") or "{n}"
    size = clamp(to_float(ctx.opt("font_size"), 12), 4, 200)
    fontname = base14(ctx.opt("font", "helvetica"), to_bool(ctx.opt("bold")),
                      to_bool(ctx.opt("italic")))
    color = parse_color(ctx.opt("color", "#000000"))
    facing = ctx.opt("mode", "single") == "facing"
    for inp in ctx.inputs:
        doc = ctx.open_pdf(inp)
        pages = sorted(set(_pages(ctx, doc)))
        total = first + len(pages) - 1
        for i, pno in enumerate(pages):
            page = doc[pno]
            _unrotate(page)
            text = fmt.replace("{n}", str(first + i)).replace("{p}", str(total))
            width = fitz.get_text_length(text, fontname=fontname, fontsize=size)
            pos = position
            if facing and (first + i) % 2 == 0:
                pos = pos.replace("left", "@").replace("right", "left").replace("@", "right")
            x, y = _anchor(pos, page.rect, width, size, margin)
            page.insert_text((x, y + size * 0.8), text, fontsize=size, fontname=fontname,
                             color=color)
        ctx.save_pdf(doc, f"{inp.stem}_numbered.pdf")


# ------------------------------------------------------------------ watermark
def _text_stamp(ctx):
    text = str(ctx.opt("text", "")).strip()
    if not text:
        raise ToolError("Enter the watermark text.")
    size = clamp(to_float(ctx.opt("font_size"), 48), 4, 400)
    fontname = base14(ctx.opt("font", "helvetica"), to_bool(ctx.opt("bold")),
                      to_bool(ctx.opt("italic")))
    opacity = clamp(to_float(ctx.opt("opacity"), 50) / 100, 0.02, 1)
    color = parse_color(ctx.opt("color", "#5b5bd6"), (0.357, 0.357, 0.839))
    lines = text.splitlines() or [text]
    width = max(fitz.get_text_length(line, fontname=fontname, fontsize=size) for line in lines)
    lh = size * 1.2
    stamp = fitz.open()
    page = stamp.new_page(width=width + size * 0.2, height=lh * len(lines) + size * 0.1)
    for i, line in enumerate(lines):
        lw = fitz.get_text_length(line, fontname=fontname, fontsize=size)
        x = (page.rect.width - lw) / 2
        baseline = size * 0.95 + i * lh
        page.insert_text((x, baseline), line, fontsize=size, fontname=fontname, color=color,
                         fill_opacity=opacity)
        if to_bool(ctx.opt("underline")):
            page.draw_line((x, baseline + size * 0.12), (x + lw, baseline + size * 0.12),
                           color=color, width=max(size / 16, 0.5), stroke_opacity=opacity)
    return stamp


def _image_stamp(ctx):
    path = ctx.opt("image_id_path")
    if not path:
        raise ToolError("Choose an image for the watermark.")
    opacity = clamp(to_float(ctx.opt("opacity"), 50) / 100, 0.02, 1)
    with Image.open(path) as im:
        im = im.convert("RGBA")
        if opacity < 1:
            alpha = im.getchannel("A").point(lambda a: int(a * opacity))
            im.putalpha(alpha)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        w, h = im.size
    stamp = fitz.open()
    page = stamp.new_page(width=w * 0.75, height=h * 0.75)
    page.insert_image(page.rect, stream=buf.getvalue())
    return stamp


@tool("add_watermark", zip_name="pdfplume_watermarked.zip")
def add_watermark(ctx):
    kind = ctx.opt("type", "text")
    stamp = _image_stamp(ctx) if kind == "image" else _text_stamp(ctx)
    sw, sh = stamp[0].rect.width, stamp[0].rect.height
    angle = to_float(ctx.opt("rotation"), 0) % 360
    rad = math.radians(angle)
    bw = abs(sw * math.cos(rad)) + abs(sh * math.sin(rad))
    bh = abs(sw * math.sin(rad)) + abs(sh * math.cos(rad))
    position = ctx.opt("position", "middle-center")
    mosaic = to_bool(ctx.opt("mosaic"))
    overlay = ctx.opt("layer", "over") != "below"
    image_scale = clamp(to_float(ctx.opt("image_size"), 40), 5, 100) / 100
    margin = 24
    for inp in ctx.inputs:
        doc = ctx.open_pdf(inp)
        for pno in _pages(ctx, doc):
            page = doc[pno]
            _unrotate(page)
            W, H = page.rect.width, page.rect.height
            if kind == "image":
                scale = (W * image_scale) / max(bw, 1)
            else:
                scale = 1.0
            # Never let the watermark spill outside the page.
            scale = min(scale, (W - 2 * margin) / bw, (H - 2 * margin) / bh) if not mosaic else \
                min(scale, W / bw, H / bh)
            w, h = bw * scale, bh * scale
            rects = []
            if mosaic:
                gap_x, gap_y = max(w * 0.5, 20), max(h * 1.5, 30)
                y = -h / 2
                row = 0
                while y < H:
                    x = -w / 2 + (row % 2) * (w + gap_x) / 2
                    while x < W:
                        rects.append(fitz.Rect(x, y, x + w, y + h))
                        x += w + gap_x
                    y += h + gap_y
                    row += 1
            else:
                x, y = _anchor(position, page.rect, w, h, margin)
                rects.append(fitz.Rect(x, y, x + w, y + h))
            for r in rects:
                page.show_pdf_page(r, stamp, 0, keep_proportion=True, overlay=overlay, rotate=angle)
        ctx.save_pdf(doc, f"{inp.stem}_watermarked.pdf")


# ----------------------------------------------------------------------- crop
def _crop_rect(page, box):
    x0, y0 = clamp(to_float(box.get("x0")), 0, 1), clamp(to_float(box.get("y0")), 0, 1)
    x1, y1 = clamp(to_float(box.get("x1"), 1), 0, 1), clamp(to_float(box.get("y1"), 1), 0, 1)
    if x1 - x0 < 0.01 or y1 - y0 < 0.01:
        raise ToolError("The crop area is too small.")
    W, H = page.rect.width, page.rect.height
    visible = fitz.Rect(x0 * W, y0 * H, x1 * W, y1 * H)
    unrot = (visible * page.derotation_matrix).normalize()
    cb = page.cropbox
    return (unrot + (cb.x0, cb.y0, cb.x0, cb.y0)) & page.mediabox


@tool("crop_pdf", zip_name="pdfplume_cropped.zip")
def crop_pdf(ctx):
    box = ctx.opt("box") or {}
    boxes = ctx.opt("boxes") or {}
    apply = ctx.opt("apply", "all")
    for inp in ctx.inputs:
        doc = ctx.open_pdf(inp)
        if apply == "current":
            targets = [clamp(to_int(ctx.opt("page"), 0), 0, doc.page_count - 1)]
        elif apply == "range":
            targets = _pages(ctx, doc)
        else:
            targets = range(doc.page_count)
        for pno in targets:
            page = doc[pno]
            page.set_cropbox(_crop_rect(page, boxes.get(str(pno)) or box))
        ctx.save_pdf(doc, f"{inp.stem}_cropped.pdf")


# --------------------------------------------------------------- edit + sign
def decode_data_url(value):
    if not value or "," not in value:
        raise ToolError("An image could not be read.")
    return base64.b64decode(value.split(",", 1)[1])


def _with_opacity(data, opacity):
    if opacity >= 0.999:
        return data
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGBA")
        im.putalpha(im.getchannel("A").point(lambda a: int(a * opacity)))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()


def _text_html(el):
    lines = str(el.get("text", "")).split("\n")
    return "".join(f"<div>{html.escape(line) or '&#160;'}</div>" for line in lines)


def _draw_text(page, el, rect):
    size = clamp(to_float(el.get("size"), 14), 2, 400)
    family = CSS_FAMILY.get(str(el.get("font", "helvetica")).lower(), "sans-serif")
    css = [f"font-family:{family}", f"font-size:{size:.2f}px", "line-height:1.2",
           f"color:{el.get('color') or '#000000'}", f"text-align:{el.get('align') or 'left'}"]
    if to_bool(el.get("bold")):
        css.append("font-weight:bold")
    if to_bool(el.get("italic")):
        css.append("font-style:italic")
    if to_bool(el.get("underline")):
        css.append("text-decoration:underline")
    # Extra room so MuPDF never wraps or shrinks text the browser showed on one line.
    align = el.get("align") or "left"
    extra_w = rect.width * 0.08 + size
    if align == "left":
        box = fitz.Rect(rect.x0, rect.y0, rect.x1 + extra_w, rect.y1 + rect.height + size)
    elif align == "right":
        box = fitz.Rect(rect.x0 - extra_w, rect.y0, rect.x1, rect.y1 + rect.height + size)
    else:
        box = fitz.Rect(rect.x0 - extra_w / 2, rect.y0, rect.x1 + extra_w / 2,
                        rect.y1 + rect.height + size)
    page.insert_htmlbox(box, _text_html(el), css="* {" + ";".join(css) + "}",
                        opacity=clamp(to_float(el.get("opacity"), 1), 0, 1), overlay=True)


def _draw_shape(page, el, W, H):
    kind = el.get("type")
    opacity = clamp(to_float(el.get("opacity"), 1), 0, 1)
    width = clamp(to_float(el.get("width"), 2), 0, 100)
    stroke = parse_color(el["stroke"]) if el.get("stroke") else None
    fill = parse_color(el["fill"]) if el.get("fill") else None
    shape = page.new_shape()
    if kind in ("rect", "ellipse", "highlight", "whiteout"):
        r = fitz.Rect(to_float(el.get("x")) * W, to_float(el.get("y")) * H,
                      (to_float(el.get("x")) + to_float(el.get("w"))) * W,
                      (to_float(el.get("y")) + to_float(el.get("h"))) * H)
        if kind == "highlight":
            stroke, fill, width = None, parse_color(el.get("fill") or "#ffeb3b"), 0
            opacity = to_float(el.get("opacity"), 0.4)
        elif kind == "whiteout":
            stroke, fill, width, opacity = None, parse_color(el.get("fill") or "#ffffff"), 0, 1
        if kind == "ellipse":
            shape.draw_oval(r)
        else:
            shape.draw_rect(r)
    elif kind in ("line", "arrow"):
        p1 = fitz.Point(to_float(el.get("x1")) * W, to_float(el.get("y1")) * H)
        p2 = fitz.Point(to_float(el.get("x2")) * W, to_float(el.get("y2")) * H)
        shape.draw_line(p1, p2)
        stroke = stroke or (0, 0, 0)
        if kind == "arrow" and abs(p2 - p1) > 0:
            shape.finish(color=stroke, width=width, stroke_opacity=opacity, lineCap=1)
            ang = math.atan2(p2.y - p1.y, p2.x - p1.x)
            head = max(8, width * 4)
            a = fitz.Point(p2.x - head * math.cos(ang - 0.45), p2.y - head * math.sin(ang - 0.45))
            b = fitz.Point(p2.x - head * math.cos(ang + 0.45), p2.y - head * math.sin(ang + 0.45))
            shape.draw_polyline([a, p2, b, a])
            shape.finish(color=stroke, fill=stroke, width=width, stroke_opacity=opacity,
                         fill_opacity=opacity, closePath=True)
            shape.commit(overlay=True)
            return
    elif kind == "path":
        pts = [fitz.Point(to_float(x) * W, to_float(y) * H) for x, y in el.get("points") or []]
        if len(pts) < 2:
            return
        shape.draw_polyline(pts)
        stroke = stroke or (0, 0, 0)
        fill = None
    else:
        return
    shape.finish(color=stroke if width > 0 else None, fill=fill, width=width,
                 stroke_opacity=opacity, fill_opacity=opacity, lineCap=1, lineJoin=1,
                 closePath=kind not in ("path", "line"))
    shape.commit(overlay=True)


def _family_of(font):
    name = font.lower()
    if any(k in name for k in ("courier", "mono", "consol")):
        return "courier"
    if any(k in name for k in ("times", "serif", "roman", "georgia", "garamond", "cambria", "minion", "book")) \
            and "sans" not in name:
        return "times"
    return "helvetica"


def text_lines(page):
    """Horizontal lines of text with their style, positioned as fractions of the visible page."""
    from .security import visible_frac
    rot = fitz.Matrix(page.rotation_matrix)
    rot.e = rot.f = 0  # direction only
    out = []
    for block in page.get_text("dict", flags=fitz.TEXTFLAGS_TEXT)["blocks"]:
        for line in block.get("lines", []):
            d = fitz.Point(line["dir"]) * rot
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans or abs(d.y) > 0.02 or d.x < 0:
                continue
            main = max(spans, key=lambda s: len(s["text"]))
            text = "".join(s["text"] for s in line["spans"]).strip()
            out.append({
                "rect": visible_frac(page, fitz.Rect(line["bbox"])), "text": text,
                "size": round(main["size"], 2), "color": f"#{main['color']:06x}",
                "font": _family_of(main["font"]), "bold": bool(main["flags"] & 16) or "bold" in main["font"].lower(),
                "italic": bool(main["flags"] & 2) or any(k in main["font"].lower() for k in ("italic", "oblique")),
            })
    return out


def _remove_text(page, items, W, H):
    """Delete the original text under edited lines (images and drawings stay)."""
    rects = []
    for el in items:
        box = el.get("replace") if el.get("type") == "text" else None
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            continue
        r = fitz.Rect(to_float(box[0]) * W, to_float(box[1]) * H, to_float(box[2]) * W, to_float(box[3]) * H)
        inset = r.height * 0.18  # stay clear of the lines above and below
        rects.append(fitz.Rect(r.x0 - 0.5, r.y0 + inset, r.x1 + 0.5, r.y1 - inset))
    for r in rects:
        if not r.is_empty:
            page.add_redact_annot(r)
    if rects:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                              text=fitz.PDF_REDACT_TEXT_REMOVE)


def apply_elements(doc, elements, progress=None):
    """Draw editor elements (positions are fractions of the visible page) onto ``doc``."""
    by_page = {}
    for el in elements:
        pno = to_int(el.get("page"), -1)
        if 0 <= pno < doc.page_count:
            by_page.setdefault(pno, []).append(el)
    for i, (pno, items) in enumerate(sorted(by_page.items())):
        if progress:
            progress(i / max(len(by_page), 1), f"Updating page {pno + 1}")
        page = doc[pno]
        _unrotate(page)
        W, H = page.rect.width, page.rect.height
        _remove_text(page, items, W, H)
        for el in items:
            kind = el.get("type")
            if kind in ("text", "image"):
                rect = fitz.Rect(to_float(el.get("x")) * W, to_float(el.get("y")) * H,
                                 (to_float(el.get("x")) + to_float(el.get("w"))) * W,
                                 (to_float(el.get("y")) + to_float(el.get("h"))) * H)
                if rect.is_empty:
                    continue
                if kind == "text":
                    if str(el.get("text", "")).strip():
                        _draw_text(page, el, rect)
                else:
                    data = _with_opacity(decode_data_url(el.get("src")),
                                         clamp(to_float(el.get("opacity"), 1), 0, 1))
                    page.insert_image(rect, stream=data, keep_proportion=False, overlay=True)
            else:
                _draw_shape(page, el, W, H)
    return len(by_page)


@tool("edit_pdf")
def edit_pdf(ctx):
    elements = ctx.opt("elements") or []
    if not elements:
        raise ToolError("Add some text, images or shapes before saving.")
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    apply_elements(doc, elements, ctx.progress)
    ctx.save_pdf(doc, f"{inp.stem}_edited.pdf")
