"""PDF intelligence: summarizer and translator.

The summarizer works fully offline (extractive TF-IDF + MMR). It can optionally
use a local LLM through Ollama. Translation needs a translation engine; any
of these work locally: argos-translate (pip), a LibreTranslate server, Ollama.
"""

import functools
import html
import json
import math
import re
import time
import urllib.request
from collections import Counter

import pymupdf as fitz

from .. import config, engines, llm
from ..structure import detect_headings
from ..utils import to_bool
from . import ToolError, tool
from .optimize import ocr_document, page_needs_ocr

STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for from
further had has have having he her here hers herself him himself his how i if in into is it
its itself just me more most my myself no nor not now of off on once only or other our ours
ourselves out over own same she should so some such than that the their theirs them
themselves then there these they this those through to too under until up very was we were
what when where which while who whom why will with would you your yours yourself yourselves
may might must shall upon within without however therefore thus also et al use used using one
every across including whose whether although though yet still even
two three four five first second new like get got make made many much via per vs etc e g i e
le la les des un une et est en du de dans pour que qui sur pas plus par au aux ce cette
el los las del y en que por con para una es se lo como más pero sus al
der die das und ist im den von zu mit sich des auf für nicht ein eine als auch es an werden
""".split())

LANGUAGES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
    "pt": "Portuguese", "nl": "Dutch", "ru": "Russian", "uk": "Ukrainian", "pl": "Polish",
    "cs": "Czech", "sv": "Swedish", "da": "Danish", "fi": "Finnish", "nb": "Norwegian",
    "el": "Greek", "tr": "Turkish", "ar": "Arabic", "he": "Hebrew", "fa": "Persian",
    "hi": "Hindi", "bn": "Bengali", "ur": "Urdu", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "id": "Indonesian", "ms": "Malay", "vi": "Vietnamese", "th": "Thai",
    "ro": "Romanian", "hu": "Hungarian", "bg": "Bulgarian", "sk": "Slovak", "ca": "Catalan",
    "ta": "Tamil", "te": "Telugu", "tl": "Tagalog",
}


# --------------------------------------------------------------------- text
def document_passages(ctx, doc, ocr=True):
    """Text blocks in reading order: [{"page", "text", "y"}] (page is 0-based)."""
    if ocr and engines.tesseract_path() and any(page_needs_ocr(p) for p in doc):
        ocr_document(doc, ctx.opt("language", "eng"), work_dir=ctx.work_dir,
                     progress=lambda f, m: ctx.progress(f * 0.5, m))
    passages = []
    for page in doc:
        for block in page.get_text("blocks", sort=True):
            if block[6] != 0:
                continue
            text = clean_block(block[4])
            if text:
                passages.append({"page": page.number, "text": text, "y": block[1]})
    return passages


def clean_block(text):
    text = re.sub(r"-\n(?=[a-z])", "", text)
    return re.sub(r"\s*\n\s*", " ", text).strip()


def document_text(ctx, doc, ocr=True):
    return [p["text"] for p in document_passages(ctx, doc, ocr)]


SENT_SPLIT = re.compile(r"(?<=[.!?。！？])[\"'”)\]]*\s+(?=[\"'“(\[]?[A-Z0-9À-ÖØ-ÞА-Я一-鿿])")


def split_sentences(paragraphs, pages=None):
    """[(sentence, page)]; repeated sentences (headers, footers ...) count once."""
    sentences, seen = [], set()
    for i, para in enumerate(paragraphs):
        for s in SENT_SPLIT.split(para):
            s = s.strip()
            words = s.split()
            key = re.sub(r"\W+", " ", s.lower()).strip()
            if 4 <= len(words) <= 90 and re.search(r"[^\W\d_]{3,}", s) and key not in seen:
                seen.add(key)
                sentences.append((s, pages[i] if pages else None))
    return sentences


def tokens(text):
    return [w for w in re.findall(r"[^\W\d_]{2,}", text.lower()) if w not in STOPWORDS]


def extractive_summary(paragraphs, length="medium", pages=None, k=None):
    """The most representative, least redundant sentences (TF-IDF centroid + MMR).

    Returns ([{"text", "page"}], keywords, number of sentences)."""
    items = split_sentences(paragraphs, pages)
    if not items:
        return [], [], 0
    sentences = [s for s, _ in items]
    sent_tokens = [tokens(s) for s in sentences]
    n = len(sentences)
    df = Counter()
    for toks in sent_tokens:
        df.update(set(toks))
    idf = {w: math.log((n + 1) / (c + 0.5)) + 1 for w, c in df.items()}
    vecs = []
    for toks in sent_tokens:
        tf = Counter(toks)
        vecs.append({w: (1 + math.log(c)) * idf[w] for w, c in tf.items()})
    centroid = Counter()
    for v in vecs:
        centroid.update(v)
    top_terms = dict(centroid.most_common(120))

    def norm(v):
        return math.sqrt(sum(x * x for x in v.values())) or 1.0

    def cos(a, b):
        if len(a) > len(b):
            a, b = b, a
        return sum(x * b.get(w, 0) for w, x in a.items()) / (norm(a) * norm(b))

    scores = []
    for i, v in enumerate(vecs):
        s = cos(v, top_terms)
        if i < max(3, n * 0.08):
            s *= 1.15  # introductions tend to state the main point
        scores.append(s)
    if k is None:
        ratio, lo, hi = {"short": (0.05, 3, 6), "medium": (0.12, 5, 12),
                         "long": (0.22, 8, 25)}.get(length, (0.12, 5, 12))
        k = max(lo, min(hi, round(n * ratio)))
    k = min(k, n)
    chosen = []
    candidates = sorted(range(n), key=lambda i: -scores[i])[:max(60, k * 6)]
    while len(chosen) < k and candidates:
        best, best_val = None, -1e9
        for i in candidates:
            redundancy = max((cos(vecs[i], vecs[j]) for j in chosen), default=0)
            val = 0.72 * scores[i] - 0.28 * redundancy
            if val > best_val:
                best, best_val = i, val
        chosen.append(best)
        candidates.remove(best)
    summary = [{"text": sentences[i], "page": items[i][1]} for i in sorted(chosen)]
    keywords = [w for w, _ in Counter({w: c * idf[w] for w, c in
                                       Counter(t for ts in sent_tokens for t in ts).items()
                                       if df[w] > 1 or n < 15}).most_common(12)]
    return summary, keywords, n


def section_summaries(doc, passages, max_sections=40):
    """One to three key sentences for each section found from the headings."""
    heads = detect_headings(doc)
    if len(heads) < 2:
        return []
    top = min(h["level"] for h in heads)
    heads = [h for h in heads if h["level"] <= top + 1][:max_sections]
    sections = [{"title": h["title"], "level": h["level"] - top + 1, "page": h["page"], "y": h["y"],
                 "paras": [], "pages": []} for h in heads]
    j = -1
    for p in passages:
        while j + 1 < len(sections) and (sections[j + 1]["page"], sections[j + 1]["y"] - 1) <= (p["page"], p["y"]):
            j += 1
        if j < 0:
            continue
        sec = sections[j]
        if not sec["paras"] and p["text"].startswith(sec["title"][:40]):
            rest = p["text"][len(sec["title"]):].strip()
            if not rest:
                continue  # the heading's own block
            p = {**p, "text": rest}
        sec["paras"].append(p["text"])
        sec["pages"].append(p["page"])
    out = []
    for sec in sections:
        words = sum(len(t.split()) for t in sec["paras"])
        points = []
        if words >= 25:
            k = 1 if words < 250 else 2 if words < 900 else 3
            points, _, _ = extractive_summary(sec["paras"], pages=sec["pages"], k=k)
        out.append({"title": sec["title"], "level": sec["level"], "page": sec["page"] + 1,
                    "points": [{"text": pt["text"], "page": pt["page"] + 1} for pt in points]})
    return out


def _condensed(passages, limit=20000):
    """The document as text with page markers, condensed when it is too long for the LLM."""
    pages, cur = [], None
    for p in passages:
        if p["page"] != cur:
            cur = p["page"]
            pages.append(f"\n[Page {cur + 1}]")
        pages.append(p["text"])
    text = "\n".join(pages).strip()
    if len(text) <= limit:
        return text
    top, _, _ = extractive_summary([p["text"] for p in passages], pages=[p["page"] for p in passages], k=120)
    return "\n".join(f"[Page {t['page'] + 1}] {t['text']}" for t in top)[:limit]


def _ollama(prompt, timeout=600):
    return llm.generate(prompt, timeout=timeout)


@tool("summarize_pdf", max_files=1)
def summarize_pdf(ctx):
    from .convert_to import render_html
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    passages = document_passages(ctx, doc, to_bool(ctx.opt("ocr"), True))
    if not passages:
        raise ToolError("No text found in this PDF. If it is a scan, install Tesseract to "
                        "enable OCR.")
    ctx.progress(0.6, "Summarizing", force=True)
    length = ctx.opt("length", "medium")
    paragraphs = [p["text"] for p in passages]
    word_count = sum(len(p.split()) for p in paragraphs)
    summary, keywords, total_sentences = extractive_summary(paragraphs, length,
                                                            pages=[p["page"] for p in passages])
    points = [{"text": s["text"], "page": s["page"] + 1} for s in summary]
    sections = section_summaries(doc, passages) if to_bool(ctx.opt("sections"), True) else []
    engine = "extractive"
    ai_text = None
    if ctx.opt("engine") == "ollama":
        words = {"short": "about 80", "medium": "about 200", "long": "about 450"}.get(length, "200")
        try:
            ctx.progress(0.7, "Writing the summary with your local model", force=True)
            ai_text = _ollama(
                f"Summarize the document below in {words} words: clear prose, then 3-6 bullet "
                f"key points. After each key point, cite the page it comes from like (p. 3), "
                f"using the [Page N] markers. Write in the document's language.\n\n"
                f"{_condensed(passages)}")
            engine = "ollama"
        except Exception as exc:
            ctx.extra["warning"] = f"Ollama unavailable ({exc}); used the built-in summarizer."
    if not points and not ai_text:
        points = [{"text": p["text"], "page": p["page"] + 1} for p in passages[:5]]

    def cite(page):
        return f" <span style='color:#5b5bd6'>(p. {page})</span>"

    body = (f"<p>{html.escape(ai_text).replace(chr(10), '<br/>')}</p>" if ai_text else
            "<ul>" + "".join(f"<li>{html.escape(pt['text'])}{cite(pt['page'])}</li>" for pt in points) + "</ul>")
    sec_html = ""
    if sections:
        sec_html = "<h2>Section by section</h2>" + "".join(
            f"<h{3 if s['level'] == 1 else 4}>{html.escape(s['title'])}{cite(s['page'])}</h{3 if s['level'] == 1 else 4}>"
            + ("<ul>" + "".join(f"<li>{html.escape(pt['text'])}{cite(pt['page'])}</li>" for pt in s["points"]) + "</ul>"
               if s["points"] else "")
            for s in sections)
    report = (f"<h1>Summary</h1><p style='color:#666'>{html.escape(inp.name)} · "
              f"{doc.page_count} pages · {word_count:,} words · "
              f"~{max(1, round(word_count / 230))} min read</p>"
              f"{body}"
              + (f"<h3>Key terms</h3><p>{html.escape(', '.join(keywords))}</p>" if keywords else "")
              + sec_html)
    out = ctx.output_path(f"{inp.stem}_summary.pdf")
    render_html(f"<html><body>{report}</body></html>", out,
                css="body{font-family:sans-serif;font-size:11pt;line-height:1.45}"
                    "h1{font-size:20pt;color:#5b5bd6} h2{font-size:15pt;margin-top:18pt}"
                    "h3{font-size:12pt} h4{font-size:11pt} li{margin-bottom:6pt}")
    ctx.add_output(out)
    ctx.extra.update({
        "summary": [pt["text"] for pt in points], "points": points, "sections": sections,
        "ai_summary": ai_text, "keywords": keywords, "engine": engine,
        "stats": {"pages": doc.page_count, "words": word_count, "sentences": total_sentences,
                  "reading_minutes": max(1, round(word_count / 230))},
    })


# ---------------------------------------------------------------- translate
def _http_json(url, payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


@functools.lru_cache(maxsize=1)
def _argos_available():
    try:
        import argostranslate.translate  # noqa: F401
        return True
    except Exception:
        return False


_libre_cache = {"t": 0, "langs": None}


def _libre_languages():
    if not config.LIBRETRANSLATE_URL:
        return None
    if time.time() - _libre_cache["t"] < 60:
        return _libre_cache["langs"]
    try:
        langs = [item["code"] for item in _http_json(f"{config.LIBRETRANSLATE_URL}/languages",
                                                     timeout=3)]
    except Exception:
        langs = None
    _libre_cache.update(t=time.time(), langs=langs)
    return langs


def translation_status():
    engines_ = []
    languages = set()
    if _argos_available():
        try:
            import argostranslate.translate
            installed = argostranslate.translate.get_installed_languages()
            if installed:
                engines_.append("argos")
                languages.update(lang.code for lang in installed)
        except Exception:
            pass
    libre = _libre_languages()
    if libre:
        engines_.append("libretranslate")
        languages.update(libre)
    ollama = llm.available()
    if ollama:
        engines_.append("ollama")
        languages.update(LANGUAGES)
    return {"available": bool(engines_), "engines": engines_,
            "languages": [{"code": c, "name": LANGUAGES.get(c, c)}
                          for c in sorted(languages, key=lambda c: LANGUAGES.get(c, c))],
            "ollama": ollama}


class Translator:
    def __init__(self, source, target):
        self.source, self.target = source or "auto", target
        status = translation_status()
        if not status["available"]:
            raise ToolError("No translation engine is set up. Install one of: "
                            "'pip install argostranslate' (offline), a local LibreTranslate "
                            "server (set LIBRETRANSLATE_URL) or Ollama (set OLLAMA_URL). "
                            "See README → Translate PDF.")
        self.engine = status["engines"][0]
        self.cache = {}

    def translate_many(self, texts):
        todo = [t for t in dict.fromkeys(texts) if t not in self.cache and t.strip()]
        if todo:
            if self.engine == "libretranslate":
                for i in range(0, len(todo), 40):
                    chunk = todo[i:i + 40]
                    payload = {"q": chunk, "source": self.source, "target": self.target,
                               "format": "text"}
                    if config.LIBRETRANSLATE_API_KEY:
                        payload["api_key"] = config.LIBRETRANSLATE_API_KEY
                    res = _http_json(f"{config.LIBRETRANSLATE_URL}/translate", payload, 300)
                    out = res.get("translatedText")
                    if isinstance(out, str):
                        out = [out]
                    for src, dst in zip(chunk, out):
                        self.cache[src] = dst
            elif self.engine == "argos":
                import argostranslate.translate as at
                source = self.source
                if source == "auto":
                    source = _guess_language(" ".join(todo)[:2000])
                for t in todo:
                    self.cache[t] = at.translate(t, source, self.target)
            else:
                target = LANGUAGES.get(self.target, self.target)
                for t in todo:
                    self.cache[t] = _ollama(
                        f"Translate the text below into {target}. Reply with the translation "
                        f"only, no notes.\n\n{t}", timeout=300)
        return [self.cache.get(t, t) for t in texts]


def _guess_language(text):
    """Tiny stop-word based guesser used when argos needs an explicit source."""
    probes = {"en": "the and of to is", "es": "el la de que y", "fr": "le la les et des",
              "de": "der die und das ist", "it": "il di che la e", "pt": "o de que e do",
              "nl": "de het een en van"}
    words = Counter(re.findall(r"\w+", text.lower()))
    return max(probes, key=lambda k: sum(words[w] for w in probes[k].split()))


def _block_style(block):
    sizes = Counter()
    first = None
    for line in block["lines"]:
        for span in line["spans"]:
            if span["text"].strip():
                sizes[round(span["size"], 1)] += len(span["text"])
                first = first or span
    if not first:
        return None
    color = first.get("color", 0)
    font = first["font"].lower()
    family = "serif" if ("times" in font or ("serif" in font and "sans" not in font)) else \
        ("monospace" if "mono" in font or "courier" in font else "sans-serif")
    return {"size": sizes.most_common(1)[0][0], "color": f"#{color:06x}",
            "bold": bool(first["flags"] & 16) or "bold" in font, "family": family,
            "italic": bool(first["flags"] & 2)}


@tool("translate_pdf", max_files=1)
def translate_pdf(ctx):
    target = ctx.opt("target", "es")
    translator = Translator(ctx.opt("source", "auto"), target)
    inp = ctx.inputs[0]
    doc = ctx.open_pdf(inp)
    if engines.tesseract_path() and any(page_needs_ocr(p) for p in doc):
        ocr_document(doc, ctx.opt("ocr_language", "eng"), work_dir=ctx.work_dir,
                     progress=lambda f, m: ctx.progress(f * 0.3, m))
    rtl = target in ("ar", "he", "fa", "ur")
    for page in doc:
        ctx.progress(0.3 + 0.7 * page.number / doc.page_count,
                     f"Translating page {page.number + 1}", force=True)
        if page.rotation:
            page.remove_rotation()
        items = []
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            if any(abs(line["dir"][1]) > 0.01 for line in block["lines"]):
                continue
            text = " ".join("".join(s["text"] for s in line["spans"]).strip()
                            for line in block["lines"])
            text = re.sub(r"(\w)- (\w)", r"\1\2", text).strip()
            style = _block_style(block)
            if text and style and re.search(r"[^\W\d_]", text):
                items.append((fitz.Rect(block["bbox"]), text, style))
        if not items:
            continue
        translated = translator.translate_many([t for _, t, _ in items])
        for rect, _, _ in items:
            page.add_redact_annot(rect)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                              graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                              text=fitz.PDF_REDACT_TEXT_REMOVE)
        for (rect, _, style), new_text in zip(items, translated):
            css = (f"* {{font-family:{style['family']};font-size:{style['size']}px;"
                   f"color:{style['color']};line-height:1.15;"
                   f"{'font-weight:bold;' if style['bold'] else ''}"
                   f"{'font-style:italic;' if style['italic'] else ''}"
                   f"{'direction:rtl;text-align:right;' if rtl else ''}}}")
            page.insert_htmlbox(rect + (0, 0, 2, 2), html.escape(new_text), css=css)
    ctx.extra["engine"] = translator.engine
    ctx.extra["target"] = LANGUAGES.get(target, target)
    ctx.save_pdf(doc, f"{inp.stem}_{target}.pdf")
