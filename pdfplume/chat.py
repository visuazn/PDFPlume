"""Chat with a PDF: local passage search (BM25) plus an optional Ollama answer.

Without Ollama the answer is made of the document's own sentences that best
match the question, each with its page, so it never invents anything.
"""

import json
import math
import re
from collections import Counter

from . import llm
from .tools.intelligence import STOPWORDS, clean_block, extractive_summary, split_sentences
from .tools.security import visible_frac

INDEX_VERSION = 2
SUMMARY_INTENT = re.compile(r"\b(summar|overview|tl;?dr|main points|key points|what is (this|the) (document|pdf|file) about)", re.I)


def _stem(word):
    for suffix in ("ations", "ation", "ingly", "ings", "ing", "ies", "ied", "edly", "ed", "es", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[: -len(suffix)] + ("y" if suffix in ("ies", "ied") else "")
    return word


def terms(text):
    return [_stem(w) for w in re.findall(r"[^\W_]{2,}", text.lower()) if w not in STOPWORDS]


# -------------------------------------------------------------------- index
def build_index(doc, target_words=90, max_words=160):
    """Split the document into passages of roughly ``target_words`` words."""
    chunks = []

    def add(page, parts, rect):
        text = " ".join(parts)
        chunks.append({"page": page.number, "text": text, "rect": visible_frac(page, rect), "t": terms(text)})

    for page in doc:
        cur, rect, words = [], None, 0
        for block in page.get_text("blocks", sort=True):
            if block[6] != 0:
                continue
            text = clean_block(block[4])
            if not text:
                continue
            n = len(text.split())
            if cur and words + n > max_words:
                add(page, cur, rect)
                cur, rect, words = [], None, 0
            cur.append(text)
            r = block[:4]
            rect = r if rect is None else (min(rect[0], r[0]), min(rect[1], r[1]), max(rect[2], r[2]), max(rect[3], r[3]))
            words += n
            if words >= target_words:
                add(page, cur, rect)
                cur, rect, words = [], None, 0
        if cur:
            add(page, cur, rect)
    df = Counter()
    for c in chunks:
        df.update(set(w for w in re.findall(r"[^\W\d_]{4,}", c["text"].lower()) if w not in STOPWORDS))
    n = len(chunks) or 1
    common = [w for w, c in df.most_common(400) if 1 < c < max(3, n * 0.6)]
    keywords = sorted(common, key=lambda w: -df[w] * math.log(n / df[w] + 1))[:6]
    return {"version": INDEX_VERSION, "pages": doc.page_count, "chunks": chunks, "keywords": keywords,
            "words": sum(len(c["text"].split()) for c in chunks)}


def load_index(path):
    try:
        data = json.loads(path.read_text("utf-8"))
        return data if data.get("version") == INDEX_VERSION else None
    except (OSError, ValueError):
        return None


def save_index(path, index):
    try:
        path.write_text(json.dumps(index), "utf-8")
    except OSError:
        pass


def suggestions(index):
    out = ["Summarize this document"]
    out += [f"What does it say about {k}?" for k in index.get("keywords", [])[:3]]
    return out


# ------------------------------------------------------------------- search
def _idf(index):
    df = Counter()
    for c in index["chunks"]:
        df.update(set(c["t"]))
    n = len(index["chunks"])
    return lambda w: math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))


def search(index, query, k=6, idf=None):
    """[(score, chunk)] best first, BM25 with a bonus for the exact phrase."""
    q = terms(query)
    if not q:
        return []
    chunks = index["chunks"]
    docs = [c["t"] for c in chunks]
    avg = sum(map(len, docs)) / max(1, len(docs))
    idf = idf or _idf(index)
    phrase = " ".join(w for w in re.findall(r"\w+", query.lower()) if w not in STOPWORDS)
    scored = []
    for c, d in zip(chunks, docs):
        tf = Counter(d)
        s = 0.0
        for w in set(q):
            if tf[w]:
                s += idf(w) * tf[w] * 2.2 / (tf[w] + 1.2 * (0.25 + 0.75 * len(d) / max(avg, 1)))
        if s and len(phrase) > 6 and phrase in c["text"].lower():
            s *= 1.5
        if s:
            scored.append((s, c))
    scored.sort(key=lambda x: -x[0])
    return scored[:k]


# ------------------------------------------------------------------- answer
def _trim(sentence, limit=320):
    return sentence if len(sentence) <= limit else sentence[:limit].rsplit(" ", 1)[0] + " …"


def _offline_answer(question, hits, idf):
    """The document's own sentences that cover the question's rarest words best."""
    q = set(terms(question))
    cands = []
    for rank, (_score, c) in enumerate(hits[:5]):
        for sent, _ in split_sentences([c["text"]]) or [(c["text"], None)]:
            t = set(terms(sent))
            hit = q & t
            if hit:
                cover = sum(idf(w) for w in hit) / (sum(idf(w) for w in q) or 1)
                cands.append((cover - 0.012 * math.sqrt(len(t)) - 0.03 * rank, _trim(sent), c["page"]))
    cands.sort(key=lambda x: -x[0])
    if not cands:
        return None
    best = cands[0][0]
    picked = [c for c in cands[:3] if c[0] >= best * 0.6]
    return "\n".join(f"• {sent} [p. {page + 1}]" for _, sent, page in picked)


def _summary_answer(index):
    chunks = index["chunks"]
    points, _, _ = extractive_summary([c["text"] for c in chunks], "short", pages=[c["page"] for c in chunks])
    return "\n".join(f"• {_trim(p['text'])} [p. {p['page'] + 1}]" for p in points)


def answer(index, question, history=()):
    history = [m for m in history if isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("content"), str)][-6:]
    query = question
    prev = [m["content"] for m in history if m["role"] == "user"]
    if prev and len(terms(question)) < 4:
        query = f"{question} {prev[-1]}"  # follow-ups like "and the second one?"
    wants_summary = bool(SUMMARY_INTENT.search(question))
    idf = _idf(index)
    hits = search(index, query, idf=idf)
    if wants_summary and not hits:
        hits = [(1.0, c) for c in index["chunks"][:6]]
    st = llm.status()
    result = {"sources": [{"page": c["page"], "text": _trim(c["text"], 420), "rect": c["rect"]} for _, c in hits[:4]],
              "engine": "offline", "model": ""}
    if st["available"] and hits:
        context = "\n\n".join(f"[p. {c['page'] + 1}] {c['text']}" for _, c in (hits if not wants_summary else
                              [(0, c) for c in index["chunks"][:40]])[:40])[:14000]
        system = ("You answer questions about a PDF document using only the excerpts you are given. "
                  "After each fact, cite its page exactly like [p. 4]. If the excerpts do not contain the "
                  "answer, say that the document does not seem to cover it. Answer in the language of the "
                  "question, briefly and plainly.")
        messages = [{"role": "system", "content": system}]
        messages += [{"role": m["role"], "content": m["content"][:2000]} for m in history]
        messages.append({"role": "user", "content": f"Excerpts from the document:\n\n{context}\n\nQuestion: {question}"})
        try:
            result.update(answer=llm.chat(messages, timeout=300), engine="ollama", model=st["model"])
            return result
        except Exception as exc:
            result["warning"] = f"Ollama didn’t answer ({exc}), so here are the closest passages."
    if wants_summary:
        text = _summary_answer(index)
    else:
        text = _offline_answer(question, hits, idf) if hits else None
    result["answer"] = text or "I couldn’t find anything about that in this document. Try other words, or a name or number that appears in it."
    if not text:
        result["sources"] = []
    return result
