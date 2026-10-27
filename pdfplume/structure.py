"""Document structure helpers: headings detected from font size and weight.

Used to suggest bookmarks and to split summaries into sections.
"""

import re
from collections import Counter

import pymupdf as fitz


def _lines(doc):
    for page in doc:
        data = page.get_text("dict", flags=fitz.TEXTFLAGS_TEXT, sort=True)
        for bno, block in enumerate(data["blocks"]):
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                spans = [s for s in line["spans"] if s["text"].strip()]
                if not spans:
                    continue
                yield {
                    "page": page.number,
                    "block": bno,
                    "text": " ".join(s["text"].strip() for s in spans),
                    "size": round(max(s["size"] for s in spans) * 2) / 2,
                    "bold": all(s["flags"] & 16 or "bold" in s["font"].lower() for s in spans),
                    "chars": sum(len(s["text"]) for s in spans),
                    "y": line["bbox"][1],
                    "x0": line["bbox"][0], "x1": line["bbox"][2], "y1": line["bbox"][3],
                    "margin": not (0.07 < line["bbox"][1] / (page.rect.height or 1) < 0.93),
                }


def detect_headings(doc, max_items=300):
    """[{level, title, page, y}] for lines that look like headings, in reading order."""
    lines = list(_lines(doc))
    if not lines:
        return []
    sizes = Counter()
    for ln in lines:
        sizes[ln["size"]] += ln["chars"]
    body = sizes.most_common(1)[0][0]
    # Lines repeated on many pages are running headers/footers, not headings
    # (small "Page 2 of 9"-style lines in the page margin count as repeats too).
    def key(ln):
        if ln["margin"] and ln["size"] < body * 1.5:
            return re.sub(r"\d+", "#", ln["text"].lower())
        return ln["text"].lower()
    repeats = Counter(key(ln) for ln in lines)
    many = max(3, doc.page_count * 0.3)

    # Lines that share their baseline with another, separate line are table cells.
    rows = {}
    for ln in lines:
        rows.setdefault((ln["page"], round(ln["y1"])), []).append(ln)

    def in_table_row(ln):
        for key in ((ln["page"], round(ln["y1"]) + d) for d in (-1, 0, 1)):
            if any(o is not ln and (o["x0"] > ln["x1"] + 4 or o["x1"] < ln["x0"] - 4) for o in rows.get(key, ())):
                return True
        return False

    cands = []
    for ln in lines:
        text = ln["text"]
        words = text.split()
        bigger = ln["size"] >= body * 1.18
        if not (bigger or (ln["bold"] and ln["size"] >= body * 0.95)):
            continue
        if not (2 <= len(text) <= 140 and len(words) <= 18) or not re.search(r"[^\W\d_]{2,}", text):
            continue
        if text.endswith((",", ";")) or (not bigger and text.endswith(".") and len(words) > 6):
            continue
        if repeats[key(ln)] > many and doc.page_count > 2:
            continue
        if not bigger and in_table_row(ln):  # bold table headers and totals are not headings
            continue
        prev = cands[-1] if cands else None
        if (prev and prev["page"] == ln["page"] and prev["block"] == ln["block"]
                and prev["size"] == ln["size"] and len(prev["title"]) < 120):
            prev["title"] += " " + text  # a heading wrapped over two lines
            continue
        cands.append({"title": text, "page": ln["page"], "block": ln["block"], "size": ln["size"],
                      "bold": ln["bold"], "bigger": bigger, "y": ln["y"]})
    if not cands:
        return []
    big = sorted({c["size"] for c in cands if c["bigger"]}, reverse=True)
    level_of = {s: min(i + 1, 3) for i, s in enumerate(big)}
    bold_level = min(len(big) + 1, 3)
    out = []
    for c in cands:
        level = level_of[c["size"]] if c["bigger"] else bold_level
        out.append({"level": level, "title": c["title"].strip(), "page": c["page"], "y": round(c["y"], 1)})
    if len(out) > max_items:  # far too many: keep only the top levels
        top = min(o["level"] for o in out)
        out = [o for o in out if o["level"] <= top + 1][:max_items]
    # Levels must start at 1 and never jump by more than one.
    prev = 0
    for o in out:
        o["level"] = max(1, min(o["level"], prev + 1))
        prev = o["level"]
    return out


def normalize_toc(items, page_count):
    """Clean user-supplied bookmarks into a list PyMuPDF's set_toc accepts."""
    toc, prev = [], 0
    for item in items or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:500]
        if not title:
            continue
        try:
            level = int(item.get("level") or 1)
            page = int(item.get("page") or 1)
        except (TypeError, ValueError):
            continue
        level = max(1, min(level, prev + 1))
        toc.append([level, title, max(1, min(page, page_count))])
        prev = level
    return toc
