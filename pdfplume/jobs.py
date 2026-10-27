"""Runs tool jobs in a pool of worker processes.

MuPDF is not thread safe, so heavy work happens in separate processes. Each
worker reports progress by writing ``progress.json`` into the job directory
and the final status into ``result.json``; the web server only reads files.
"""

import multiprocessing
import threading
import time
from concurrent.futures import ProcessPoolExecutor

from . import config
from .storage import read_json, write_json
from .tools import run_job


class JobManager:
    def __init__(self, storage, workers=None):
        self.storage = storage
        self.workers = workers or config.WORKERS
        self._pool = None
        self._lock = threading.Lock()
        self._futures = {}

    def _get_pool(self):
        with self._lock:
            if self._pool is None:
                self._pool = ProcessPoolExecutor(
                    max_workers=self.workers,
                    mp_context=multiprocessing.get_context("spawn"))
            return self._pool

    def submit(self, slug, inputs, options):
        job_id, job_dir = self.storage.new_job()
        write_json(job_dir / "job.json", {"tool": slug, "created": time.time(),
                                          "files": [i.get("id") for i in inputs]})
        write_json(job_dir / "progress.json", {"progress": 0, "message": "Queued"})
        try:
            future = self._get_pool().submit(run_job, slug, inputs, options, str(job_dir))
        except Exception:
            # A crashed pool cannot accept work; start a fresh one.
            with self._lock:
                self._pool = None
            future = self._get_pool().submit(run_job, slug, inputs, options, str(job_dir))
        self._futures[job_id] = future
        return job_id

    def status(self, job_id):
        job_dir = self.storage.job_dir(job_id)
        if not job_dir.exists():
            return None
        result = read_json(job_dir / "result.json")
        if result:
            self._futures.pop(job_id, None)
            return result
        future = self._futures.get(job_id)
        if future is not None and future.cancelled():
            self._futures.pop(job_id, None)
            return {"status": "cancelled", "message": "Cancelled"}
        if future is not None and future.done():
            exc = future.exception()
            if exc is not None:
                self._futures.pop(job_id, None)
                if isinstance(exc, Exception) and "terminated abruptly" in str(exc):
                    with self._lock:
                        self._pool = None
                return {"status": "error",
                        "message": "The worker process crashed while processing the file."}
        progress = read_json(job_dir / "progress.json", {}) or {}
        return {"status": "running", "progress": progress.get("progress", 0),
                "message": progress.get("message", "Processing")}

    def cancel(self, job_id):
        """Ask a job to stop. Queued jobs never start; running ones stop at the
        next progress update (external programs are killed)."""
        job_dir = self.storage.job_dir(job_id)
        if not job_dir.exists() or read_json(job_dir / "result.json"):
            return False
        (job_dir / "cancel").write_text("1")
        future = self._futures.get(job_id)
        if future is not None and future.cancel():
            write_json(job_dir / "result.json", {"status": "cancelled", "message": "Cancelled"})
        return True

    def run_inline(self, slug, inputs, options):
        """Synchronous execution (used by tests and the CLI)."""
        job_id, job_dir = self.storage.new_job()
        result = run_job(slug, inputs, options, str(job_dir))
        return job_id, result

    def shutdown(self, terminate=False):
        if self._pool is not None:
            procs = list((getattr(self._pool, "_processes", None) or {}).values())
            self._pool.shutdown(wait=False, cancel_futures=True)
            if terminate:  # the app is quitting: don't leave busy workers behind
                for proc in procs:
                    proc.terminate()
