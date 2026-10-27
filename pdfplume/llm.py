"""Optional local LLM through Ollama (https://ollama.com).

OLLAMA_URL picks the server; without it PDFPlume looks for Ollama on its default
address. Nothing here is required: every caller has an offline fallback.
"""

import json
import os
import threading
import time
import urllib.request

from . import config

DEFAULT_URL = "http://127.0.0.1:11434"
_cache = {"t": 0.0, "status": None}
_lock = threading.Lock()


def _get(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())


def status(max_age=30):
    """{"available", "url", "model", "models"} - cached for ``max_age`` seconds."""
    with _lock:
        if _cache["status"] is not None and time.time() - _cache["t"] < max_age:
            return _cache["status"]
    url = config.OLLAMA_URL
    if not url and os.environ.get("PDFPLUME_OLLAMA_AUTODETECT", "1") != "0":
        url = DEFAULT_URL
    result = {"available": False, "url": url or "", "model": "", "models": []}
    if url:
        try:
            models = [m["name"] for m in _get(f"{url}/api/tags", 1.5).get("models", [])]
            wanted = config.OLLAMA_MODEL
            model = next((m for m in models if m == wanted or m.split(":")[0] == wanted.split(":")[0]), None)
            if model is None and config.OLLAMA_URL and not models:
                model = wanted  # an explicitly configured server that hides its model list
            model = model or (models[0] if models else "")
            result.update(available=bool(model), model=model, models=models)
        except Exception:
            pass
    with _lock:
        _cache.update(t=time.time(), status=result)
    return result


def available():
    return status()["available"]


def chat(messages, timeout=600, temperature=0.2):
    """Send a chat to the local model and return the reply text."""
    st = status()
    if not st["available"]:
        raise RuntimeError("Ollama is not running")
    payload = {"model": st["model"], "messages": messages, "stream": False,
               "options": {"temperature": temperature, "num_ctx": 8192}}
    req = urllib.request.Request(f"{st['url']}/api/chat", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())["message"]["content"].strip()


def generate(prompt, system=None, timeout=600):
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    return chat(messages, timeout=timeout)
