"""On-disk workspace for uploaded files and job results.

Layout::

    data/uploads/<file_id>/input.<ext>   the uploaded file
    data/uploads/<file_id>/meta.json     name, size, kind, page count ...
    data/uploads/<file_id>/cache/        rendered page images
    data/jobs/<job_id>/out/              files produced by a tool
    data/jobs/<job_id>/result.json       status written by the worker
"""

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import config
from .utils import file_kind

ID_RE = re.compile(r"^[a-f0-9]{32}$")


def new_id():
    return uuid.uuid4().hex


def valid_id(value):
    return bool(value) and bool(ID_RE.match(value))


def write_json(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class Storage:
    def __init__(self, root=None):
        self.root = Path(root or config.DATA_DIR)
        self.uploads = self.root / "uploads"
        self.jobs = self.root / "jobs"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.jobs.mkdir(parents=True, exist_ok=True)

    # ---- uploads -------------------------------------------------------
    def upload_dir(self, file_id):
        if not valid_id(file_id):
            raise KeyError(file_id)
        return self.uploads / file_id

    def add_file(self, name, writer):
        """Create a new upload. ``writer(path)`` must write the content to ``path``."""
        file_id = new_id()
        d = self.uploads / file_id
        d.mkdir(parents=True)
        ext = Path(name).suffix.lower()[:10]
        path = d / f"input{ext}"
        writer(path)
        meta = {
            "id": file_id,
            "name": Path(name).name or f"file{ext}",
            "ext": ext,
            "kind": file_kind(ext),
            "size": path.stat().st_size,
            "created": time.time(),
        }
        write_json(d / "meta.json", meta)
        return meta

    def get_meta(self, file_id):
        d = self.upload_dir(file_id)
        meta = read_json(d / "meta.json")
        if not meta:
            raise KeyError(file_id)
        meta["path"] = str(d / f"input{meta['ext']}")
        return meta

    def update_meta(self, file_id, **fields):
        d = self.upload_dir(file_id)
        meta = read_json(d / "meta.json") or {}
        meta.update(fields)
        write_json(d / "meta.json", meta)
        return meta

    def delete_file(self, file_id):
        shutil.rmtree(self.upload_dir(file_id), ignore_errors=True)

    def cache_dir(self, file_id):
        d = self.upload_dir(file_id) / "cache"
        d.mkdir(exist_ok=True)
        return d

    # ---- jobs ----------------------------------------------------------
    def job_dir(self, job_id):
        if not valid_id(job_id):
            raise KeyError(job_id)
        return self.jobs / job_id

    def new_job(self):
        job_id = new_id()
        d = self.jobs / job_id
        (d / "out").mkdir(parents=True)
        return job_id, d

    def delete_job(self, job_id):
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    # ---- housekeeping ----------------------------------------------------
    def cleanup(self, ttl_minutes=None):
        ttl = (ttl_minutes if ttl_minutes is not None else config.FILE_TTL_MINUTES) * 60
        cutoff = time.time() - ttl
        removed = 0
        for base in (self.uploads, self.jobs):
            for d in base.iterdir():
                try:
                    if d.is_dir() and d.stat().st_mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                        removed += 1
                except OSError:
                    pass
        return removed

    def start_cleanup_thread(self, interval=600):
        def loop():
            while True:
                time.sleep(interval)
                try:
                    self.cleanup()
                except Exception:
                    pass

        t = threading.Thread(target=loop, name="pdfplume-cleanup", daemon=True)
        t.start()
        return t
