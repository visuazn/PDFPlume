"""Flask web server: serves the UI and the JSON API."""

import io
import re
import shutil
import threading
import time
from pathlib import Path

import pymupdf as fitz
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageOps

from . import __version__, chat, config, engines, llm
from .certs import CertError, CertStore, verify_pdf
from .jobs import JobManager
from .storage import Storage, read_json, valid_id, write_json
from .tools import registry
from .utils import file_kind, parse_page_ranges

# MuPDF must not be used from several threads at once.
MUPDF_LOCK = threading.RLock()
INTERACTIVE_TOOLS = {"chat_pdf"}  # tool pages that work without a processing job
STATIC_DIR = Path(__file__).resolve().parent / "static"


def create_app(storage=None, jobs=None):
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_MB * 1024 * 1024
    app.json.sort_keys = False
    storage = storage or Storage()
    jobs = jobs or JobManager(storage)
    app.extensions["pdfplume_storage"] = storage
    app.extensions["pdfplume_jobs"] = jobs
    certstore = CertStore(storage.root / "certificates")
    fitz.TOOLS.mupdf_display_errors(False)
    fitz.TOOLS.mupdf_display_warnings(False)

    def err(message, code=400):
        return jsonify({"error": message}), code

    def get_meta_or_404(file_id):
        try:
            return storage.get_meta(file_id)
        except KeyError:
            abort(404)

    def open_doc(meta):
        doc = fitz.open(meta["path"])
        if doc.needs_pass:
            if not meta.get("password") or not doc.authenticate(meta["password"]):
                doc.close()
                abort(423)
        return doc

    def inspect_pdf(meta):
        info = {"pages": 0, "encrypted": False, "needs_password": False}
        with MUPDF_LOCK:
            try:
                doc = fitz.open(meta["path"])
            except Exception:
                info["damaged"] = True
                return info
            try:
                info["encrypted"] = bool(doc.is_encrypted or doc.needs_pass)
                if doc.needs_pass and not (meta.get("password") and doc.authenticate(meta["password"])):
                    info["needs_password"] = True
                    return info
                info["pages"] = doc.page_count
                if doc.page_count:
                    r = doc[0].rect
                    info["width"], info["height"] = round(r.width, 2), round(r.height, 2)
            finally:
                doc.close()
        return info

    def public_meta(meta):
        return {k: v for k, v in meta.items() if k not in ("path", "password")}

    # ------------------------------------------------------------------ pages
    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/<slug>")
    def tool_page(slug):
        if slug not in registry() and slug not in INTERACTIVE_TOOLS:
            abort(404)
        return send_from_directory(STATIC_DIR, "tool.html")

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(STATIC_DIR, "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        # Served from the root so it may control every page of the app.
        resp = send_from_directory(STATIC_DIR, "sw.js", mimetype="text/javascript", max_age=0)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/favicon.ico")
    def favicon():
        return send_from_directory(STATIC_DIR / "img", "favicon.svg", mimetype="image/svg+xml")

    # -------------------------------------------------------------------- api
    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "version": __version__})

    @app.get("/api/capabilities")
    def capabilities():
        from .tools.intelligence import translation_status
        caps = engines.capabilities()
        caps["translation"] = translation_status()
        st = llm.status()
        caps["llm"] = {"available": st["available"], "model": st["model"]}
        caps["file_ttl_minutes"] = config.FILE_TTL_MINUTES
        caps["max_upload_mb"] = config.MAX_UPLOAD_MB
        return jsonify(caps)

    @app.post("/api/upload")
    def upload():
        f = request.files.get("file")
        if f is None or not f.filename:
            return err("No file received.")
        meta = storage.add_file(f.filename, lambda p: f.save(p))
        if meta["kind"] == "pdf":
            meta = storage.update_meta(meta["id"], **inspect_pdf(storage.get_meta(meta["id"])))
        elif meta["kind"] == "image":
            try:
                with Image.open(storage.get_meta(meta["id"])["path"]) as im:
                    meta = storage.update_meta(meta["id"], width=im.width, height=im.height,
                                               pages=getattr(im, "n_frames", 1))
            except Exception:
                storage.delete_file(meta["id"])
                return err(f"'{f.filename}' is not a valid image.")
        return jsonify(public_meta(meta))

    @app.post("/api/upload-url")
    def upload_url():
        """Download a remote file (e.g. from a URL the user pasted)."""
        import urllib.request
        url = (request.get_json(silent=True) or {}).get("url", "").strip()
        if not re.match(r"^https?://", url):
            return err("Please enter a valid http(s) URL.")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 PDFPlume"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read(config.MAX_UPLOAD_MB * 1024 * 1024)
                name = Path(resp.url.split("?")[0]).name or "download.pdf"
                if "." not in name and "pdf" in resp.headers.get("Content-Type", ""):
                    name += ".pdf"
        except Exception as exc:
            return err(f"Could not download the file: {exc}")
        meta = storage.add_file(name, lambda p: p.write_bytes(data))
        if meta["kind"] == "pdf":
            meta = storage.update_meta(meta["id"], **inspect_pdf(storage.get_meta(meta["id"])))
        return jsonify(public_meta(meta))

    @app.get("/api/files/<file_id>")
    def file_info(file_id):
        return jsonify(public_meta(get_meta_or_404(file_id)))

    @app.delete("/api/files/<file_id>")
    def delete_file(file_id):
        if valid_id(file_id):
            storage.delete_file(file_id)
        return jsonify({"ok": True})

    @app.post("/api/files/<file_id>/password")
    def set_password(file_id):
        meta = get_meta_or_404(file_id)
        password = (request.get_json(silent=True) or {}).get("password", "")
        with MUPDF_LOCK:
            doc = fitz.open(meta["path"])
            ok = (not doc.needs_pass) or bool(doc.authenticate(password))
            doc.close()
        if not ok:
            return err("Wrong password, please try again.", 403)
        storage.update_meta(file_id, password=password)
        meta = storage.update_meta(file_id, **inspect_pdf(storage.get_meta(file_id)))
        return jsonify(public_meta(meta))

    @app.get("/api/files/<file_id>/download")
    def download_original(file_id):
        meta = get_meta_or_404(file_id)
        return send_file(meta["path"], download_name=meta["name"],
                         as_attachment=not request.args.get("inline"))

    @app.get("/api/files/<file_id>/pages")
    def page_sizes(file_id):
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                pages = [{"w": round(p.rect.width, 2), "h": round(p.rect.height, 2),
                          "rotation": p.rotation} for p in doc]
            finally:
                doc.close()
        return jsonify({"pages": pages})

    @app.get("/api/files/<file_id>/thumb/<int:page>")
    def thumbnail(file_id, page):
        meta = get_meta_or_404(file_id)
        width = max(40, min(int(request.args.get("w", 240)), 2400))
        annots = request.args.get("annots") != "0"  # the form filler draws its own fields
        cache = storage.cache_dir(file_id) / f"p{page}_w{width}{'' if annots else '_bare'}.png"
        if not cache.exists():
            if meta["kind"] == "pdf":
                with MUPDF_LOCK:
                    doc = open_doc(meta)
                    try:
                        if page < 0 or page >= doc.page_count:
                            abort(404)
                        p = doc[page]
                        zoom = width / max(p.rect.width, 1)
                        pix = p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False, annots=annots)
                        pix.save(str(cache))
                    finally:
                        doc.close()
            elif meta["kind"] == "image":
                try:
                    with Image.open(meta["path"]) as im:
                        if page and getattr(im, "n_frames", 1) > page:
                            im.seek(page)
                        im = ImageOps.exif_transpose(im)
                        im.thumbnail((width, width * 4))
                        if im.mode not in ("RGB", "RGBA", "L"):
                            im = im.convert("RGBA")
                        im.save(cache, "PNG")
                except Exception:
                    abort(404)
            else:
                abort(404)
        return send_file(cache, mimetype="image/png", max_age=3600)

    @app.post("/api/files/<file_id>/search")
    def search(file_id):
        """Find text (or a regular expression) - used by the Redact tool preview."""
        from .tools.security import find_matches
        meta = get_meta_or_404(file_id)
        body = request.get_json(silent=True) or {}
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                matches = find_matches(doc, body.get("terms") or [], body.get("patterns") or [],
                                       case_sensitive=bool(body.get("case_sensitive")),
                                       whole_words=bool(body.get("whole_words")))
            finally:
                doc.close()
        out = []
        for m in matches:
            out.append({"page": m["page"], "text": m["text"], "rect": m["frac"]})
        return jsonify({"matches": out[:5000], "total": len(out)})

    @app.get("/api/files/<file_id>/fields")
    def form_fields(file_id):
        from .tools.forms import list_fields
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                fields = list_fields(doc)
                # XFA-only forms (LiveCycle) have no widgets we can fill.
                xfa = doc.xref_get_key(doc.pdf_catalog(), "AcroForm/XFA")[0] != "null"
            finally:
                doc.close()
        return jsonify({"fields": fields, "xfa": xfa})

    @app.get("/api/files/<file_id>/outline")
    def outline(file_id):
        from .tools.forms import read_outline
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                data = read_outline(doc)
            finally:
                doc.close()
        return jsonify(data)

    def chat_index(file_id, meta):
        path = storage.cache_dir(file_id) / "chat_index.json"
        index = chat.load_index(path)
        if index is None:
            with MUPDF_LOCK:
                doc = open_doc(meta)
                try:
                    index = chat.build_index(doc)
                finally:
                    doc.close()
            chat.save_index(path, index)
        return index

    # -------------------------------------------------------- certificates
    @app.get("/api/certificates")
    def certificates():
        return jsonify({"certificates": certstore.list()})

    @app.post("/api/certificates")
    def create_certificate():
        body = request.get_json(silent=True) or {}
        try:
            info = certstore.create(body.get("name"), str(body.get("password") or ""),
                                    email=str(body.get("email") or "").strip(),
                                    organization=str(body.get("organization") or "").strip())
        except CertError as exc:
            return err(str(exc))
        return jsonify(info)

    @app.post("/api/certificates/import")
    def import_certificate():
        f = request.files.get("file")
        if f is None:
            return err("Choose a .p12 or .pfx file.")
        data = f.read()
        if len(data) > 1024 * 1024:
            return err("That file is too large to be a certificate.")
        try:
            info = certstore.import_p12(data, request.form.get("password", ""))
        except CertError as exc:
            return err(str(exc))
        return jsonify(info)

    @app.delete("/api/certificates/<cert_id>")
    def delete_certificate(cert_id):
        try:
            certstore.delete(cert_id)
        except CertError as exc:
            return err(str(exc), 404)
        return jsonify({"ok": True})

    @app.get("/api/certificates/<cert_id>/download")
    def download_certificate(cert_id):
        try:
            info, pem = certstore.info(cert_id), certstore.public_pem(cert_id)
        except CertError as exc:
            return err(str(exc), 404)
        name = re.sub(r"[^\w.-]+", "_", info.get("name") or "certificate").strip("_") or "certificate"
        return send_file(io.BytesIO(pem), mimetype="application/x-pem-file", as_attachment=True,
                         download_name=f"{name}.cer")

    @app.get("/api/files/<file_id>/signatures")
    def signatures(file_id):
        """Digital signatures already in a PDF, and whether they are intact."""
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        try:
            sigs = verify_pdf(meta["path"], trusted=certstore.trusted())
        except Exception:
            sigs = []
        return jsonify({"signatures": sigs})

    @app.get("/api/files/<file_id>/textlines/<int:page>")
    def textlines(file_id, page):
        """Existing lines of text on a page (Edit PDF → Edit text)."""
        from .tools.edit import text_lines
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                if page < 0 or page >= doc.page_count:
                    abort(404)
                lines = text_lines(doc[page])
            finally:
                doc.close()
        return jsonify({"lines": lines})

    @app.get("/api/files/<file_id>/detect")
    def detect_page(file_id):
        """Where the sheet of paper is in a photo (Scan to PDF auto-crop)."""
        from . import scan
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "image":
            return err("Not an image.")
        cache = storage.cache_dir(file_id) / "detect.json"
        data = read_json(cache, None) if cache.exists() else None
        if data is None:
            try:
                with Image.open(meta["path"]) as im:
                    data = scan.detect_document(ImageOps.exif_transpose(im))
            except Exception:
                return err("This image could not be read.")
            write_json(cache, data)
        return jsonify(data)

    @app.get("/api/files/<file_id>/chat")
    def chat_info(file_id):
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        index = chat_index(file_id, meta)
        st = llm.status(max_age=5)
        return jsonify({"pages": index["pages"], "words": index["words"], "passages": len(index["chunks"]),
                        "suggestions": chat.suggestions(index), "llm": {"available": st["available"], "model": st["model"]}})

    @app.post("/api/files/<file_id>/ask")
    def ask(file_id):
        meta = get_meta_or_404(file_id)
        if meta["kind"] != "pdf":
            return err("Not a PDF.")
        body = request.get_json(silent=True) or {}
        question = str(body.get("question") or "").strip()[:2000]
        if not question:
            return err("Type a question first.")
        index = chat_index(file_id, meta)
        if not index["chunks"]:
            return jsonify({"answer": "This PDF has no selectable text, so there is nothing to search. "
                                      "Run OCR PDF on it first, then ask again.",
                            "sources": [], "engine": "none", "needs_ocr": True})
        history = body.get("history") if isinstance(body.get("history"), list) else []
        result = chat.answer(index, question, history)
        if result.get("quotes"):
            with MUPDF_LOCK:
                doc = open_doc(meta)
                try:
                    chat.locate_quotes(doc, result["quotes"])
                finally:
                    doc.close()
        return jsonify(result)

    @app.get("/api/files/<file_id>/text")
    def page_text(file_id):
        meta = get_meta_or_404(file_id)
        pages = request.args.get("pages", "all")
        with MUPDF_LOCK:
            doc = open_doc(meta)
            try:
                idx = parse_page_ranges(pages, doc.page_count)
                text = [{"page": i, "text": doc[i].get_text()} for i in idx[:500]]
            finally:
                doc.close()
        return jsonify({"pages": text})

    # ---------------------------------------------------------------- jobs
    @app.post("/api/process/<slug>")
    def process(slug):
        tools = registry()
        spec = tools.get(slug)
        if spec is None:
            return err("Unknown tool.", 404)
        body = request.get_json(silent=True) or {}
        files = body.get("files") or []
        inputs = []
        for item in files:
            fid = item.get("id") if isinstance(item, dict) else item
            try:
                meta = storage.get_meta(fid)
            except KeyError:
                return err("A file is missing or expired. Please upload it again.", 410)
            if meta["kind"] not in spec["accept"]:
                return err(f"'{meta['name']}' cannot be used with this tool.")
            entry = dict(meta)
            if isinstance(item, dict):
                if item.get("password"):
                    entry["password"] = item["password"]
                entry["options"] = item.get("options") or {}
            inputs.append(entry)
        if len(inputs) < spec["min_files"]:
            need = spec["min_files"]
            return err(f"Please select at least {need} file{'s' if need > 1 else ''}.")
        if spec["max_files"] and len(inputs) > spec["max_files"]:
            return err(f"This tool accepts at most {spec['max_files']} file(s).")
        options = body.get("options") or {}
        digital = options.get("digital")
        if isinstance(digital, dict) and digital.get("cert_id"):
            try:
                digital["cert_path"] = str(certstore.path(digital["cert_id"]))
            except CertError as exc:
                return err(str(exc), 410)
        # Extra uploaded files referenced by options (watermark image, compare file ...)
        for key in ("image_id",):
            if options.get(key):
                try:
                    options[key + "_path"] = storage.get_meta(options[key])["path"]
                except KeyError:
                    return err("The image file expired, please add it again.", 410)
        job_id = jobs.submit(slug, inputs, options)
        return jsonify({"job_id": job_id})

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id):
        if not valid_id(job_id):
            abort(404)
        status = jobs.status(job_id)
        if status is None:
            return err("This task has expired.", 404)
        return jsonify(status)

    def job_result(job_id):
        if not valid_id(job_id):
            abort(404)
        job_dir = storage.job_dir(job_id)
        result = read_json(job_dir / "result.json")
        if not result or result.get("status") != "done":
            abort(404)
        return job_dir, result

    @app.get("/api/jobs/<job_id>/download")
    def job_download(job_id):
        job_dir, result = job_result(job_id)
        name = request.args.get("file") or result["file"]
        if "/" in name or "\\" in name or name.startswith("."):
            abort(400)
        path = job_dir / "out" / name
        if not path.is_file():
            abort(404)
        inline = bool(request.args.get("inline"))
        return send_file(path, download_name=name, as_attachment=not inline)

    @app.get("/api/jobs/<job_id>/assets/<name>")
    def job_asset(job_id, name):
        job_dir, _ = job_result(job_id)
        if not re.fullmatch(r"[\w.-]+", name):
            abort(400)
        return send_from_directory(job_dir / "out" / "assets", name, max_age=3600)

    @app.get("/api/jobs/<job_id>/thumb")
    def job_thumb(job_id):
        """Preview image of one output file (first page for PDFs)."""
        job_dir, result = job_result(job_id)
        name = request.args.get("file") or result["file"]
        if "/" in name or "\\" in name or name.startswith("."):
            abort(400)
        src = job_dir / "out" / name
        if not src.is_file():
            abort(404)
        width = max(60, min(int(request.args.get("w", 440)), 1600))
        cache_dir = job_dir / "thumbs"
        cache_dir.mkdir(exist_ok=True)
        cache = cache_dir / f"{src.stem}_{src.suffix[1:]}_{width}.png"
        if not cache.exists():
            ext = src.suffix.lower()
            try:
                if ext == ".pdf":
                    with MUPDF_LOCK:
                        doc = fitz.open(src)
                        try:
                            if doc.needs_pass or not doc.page_count:
                                abort(404)
                            page = doc[0]
                            zoom = width / max(page.rect.width, 1)
                            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).save(str(cache))
                        finally:
                            doc.close()
                elif ext in (".jpg", ".jpeg", ".png"):
                    with Image.open(src) as im:
                        im.thumbnail((width, width * 3))
                        im.convert("RGB").save(cache, "PNG")
                else:
                    abort(404)
            except (OSError, RuntimeError, ValueError):
                abort(404)
        return send_file(cache, mimetype="image/png", max_age=3600)

    @app.post("/api/jobs/<job_id>/continue")
    def job_continue(job_id):
        """Register the outputs of a finished job as new uploads."""
        job_dir, result = job_result(job_id)
        metas = []
        for out in result.get("outputs", []):
            src = job_dir / "out" / out["name"]
            if not src.is_file() or file_kind(src.suffix) in ("other",):
                continue
            meta = storage.add_file(out["name"], lambda p, s=src: shutil.copyfile(s, p))
            if meta["kind"] == "pdf":
                meta = storage.update_meta(meta["id"], **inspect_pdf(storage.get_meta(meta["id"])))
            metas.append(public_meta(meta))
        return jsonify({"files": metas})

    @app.post("/api/jobs/<job_id>/cancel")
    def job_cancel(job_id):
        if not valid_id(job_id):
            abort(404)
        return jsonify({"ok": jobs.cancel(job_id)})

    @app.delete("/api/jobs/<job_id>")
    def job_delete(job_id):
        if valid_id(job_id):
            storage.delete_job(job_id)
        return jsonify({"ok": True})

    @app.errorhandler(413)
    def too_large(_e):
        return err(f"File too large. The limit is {config.MAX_UPLOAD_MB} MB.", 413)

    @app.errorhandler(423)
    def locked(_e):
        return err("This file is password protected.", 423)

    app.extensions["pdfplume_started"] = time.time()
    return app
