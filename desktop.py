#!/usr/bin/env python3
"""PDFPlume desktop launcher: starts the local server and opens it in the browser.

This is the entry point of the stand-alone app built with PyInstaller (see
packaging/). It also works from source: ``python desktop.py``.
"""

import multiprocessing
import os
import signal
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP = "PDFPlume"


def user_data_dir():
    """Where a packaged app keeps its files (uploads, results, certificates)."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP


def _running(url):
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=1) as resp:
            return b'"ok"' in resp.read()
    except Exception:
        return False


class Server:
    def __init__(self, port):
        from pdfplume import config
        from pdfplume.server import create_app
        from run import choose_port
        self.port, addresses = choose_port("127.0.0.1", port)
        self.url = f"http://localhost:{self.port}"
        self.app = create_app()
        storage = self.app.extensions["pdfplume_storage"]
        storage.cleanup()
        storage.start_cleanup_thread()
        from waitress.server import create_server
        listen = " ".join(f"[{a}]:{self.port}" if ":" in a else f"{a}:{self.port}" for a in addresses)
        self.server = create_server(self.app, listen=listen, threads=8,
                                    max_request_body_size=config.MAX_UPLOAD_MB * 1024 * 1024)
        self.thread = threading.Thread(target=self.server.run, name="pdfplume-server", daemon=True)

    def start(self):
        self.thread.start()
        for _ in range(50):
            if _running(self.url):
                return
            time.sleep(0.1)

    def stop(self):
        try:
            self.server.close()
        finally:
            self.app.extensions["pdfplume_jobs"].shutdown(terminate=True)


def status_window(server):
    """A small window with the address, Open and Quit. False if Tk is unavailable."""
    try:
        import tkinter as tk
        from tkinter import ttk
        root = tk.Tk()
    except Exception:  # no tkinter, or no display
        return False
    root.title(APP)
    root.resizable(False, False)
    frame = ttk.Frame(root, padding=18)
    frame.grid()
    ttk.Label(frame, text="PDFPlume is running on this computer", font=("", 13, "bold")).grid(column=0, row=0, columnspan=2, sticky="w")
    ttk.Label(frame, text=server.url, foreground="#5b5bd6").grid(column=0, row=1, columnspan=2, sticky="w", pady=(4, 2))
    ttk.Label(frame, text="Your files never leave this computer. Close this window to quit.",
              foreground="#666").grid(column=0, row=2, columnspan=2, sticky="w", pady=(0, 12))
    ttk.Button(frame, text="Open PDFPlume", command=lambda: webbrowser.open(server.url)).grid(column=0, row=3, sticky="w")
    ttk.Button(frame, text="Quit", command=root.destroy).grid(column=1, row=3, sticky="e")
    root.protocol("WM_DELETE_WINDOW", root.destroy)
    root.mainloop()
    return True


def main():
    os.environ.setdefault("PDFPLUME_DATA_DIR", str(user_data_dir() if getattr(sys, "frozen", False) else Path(__file__).with_name("data")))
    port = int(os.environ.get("PDFPLUME_PORT", "8765"))
    existing = f"http://localhost:{port}"
    if _running(existing):  # already open: just show it
        webbrowser.open(existing)
        return
    server = Server(port)
    server.start()
    signal.signal(signal.SIGTERM, _stop)
    print(f"\n  PDFPlume is running at  {server.url}\n  Close the PDFPlume window (or press Ctrl+C) to quit.\n")
    if "--no-browser" not in sys.argv:
        webbrowser.open(server.url)
    try:
        if "--no-window" in sys.argv or not status_window(server):
            while True:  # no window: keep running until Ctrl+C
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


def _stop(*_):
    raise KeyboardInterrupt


if __name__ == "__main__":
    multiprocessing.freeze_support()  # worker processes of the packaged app start here
    main()
