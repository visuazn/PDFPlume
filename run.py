#!/usr/bin/env python3
"""Start PDFPlume: python run.py [--host 127.0.0.1] [--port 8765] [--open]"""

import argparse
import errno
import logging
import signal
import socket
import sys
import threading
import webbrowser

from pdfplume import config

# Errors meaning "this address family/address does not exist here" (e.g. no IPv6).
_UNAVAILABLE = {errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT, getattr(errno, "WSAEADDRNOTAVAIL", -1)}


def _addresses(host):
    """Addresses to listen on. 'localhost' gets IPv4 *and* IPv6 so the browser
    reaches PDFPlume whichever one 'localhost' resolves to."""
    if host in ("127.0.0.1", "localhost"):
        return ["127.0.0.1", "::1"]
    return [host]


def _listening(addr, port):
    """True if a program accepts connections on addr:port."""
    family = socket.AF_INET6 if ":" in addr else socket.AF_INET
    target = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(addr, addr)
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex((target, port)) == 0
    except OSError:
        return False


def _usable(addresses, port):
    """Return the subset of ``addresses`` we can bind, or None if the port is taken.

    The probe deliberately does not set SO_REUSEADDR: the web server does, which
    lets it bind 127.0.0.1 even when another program (on macOS: the AirPlay
    Receiver on port 5000) already listens on all addresses of that port.
    """
    usable = []
    for addr in addresses:
        family = socket.AF_INET6 if ":" in addr else socket.AF_INET
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue
        try:
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            sock.bind((addr, port))
            usable.append(addr)
        except OSError as exc:
            if exc.errno in _UNAVAILABLE:
                continue
            if exc.errno == errno.EADDRINUSE and not _listening(addr, port):
                usable.append(addr)  # only closed connections linger (TIME_WAIT) after a restart
                continue
            return None
        finally:
            sock.close()
    return usable or None


def choose_port(host, port, tries=30):
    for candidate in range(port, port + tries):
        usable = _usable(_addresses(host), candidate)
        if usable:
            if candidate != port:
                hint = " (on macOS this is usually the AirPlay Receiver)" if port == 5000 else ""
                print(f"\n  Port {port} is already used by another program{hint}; "
                      f"using port {candidate} instead.")
            return candidate, usable
    sys.exit(f"No free port found between {port} and {port + tries - 1}. "
             "Start PDFPlume with --port <number>.")


def main():
    parser = argparse.ArgumentParser(description="PDFPlume - every PDF tool, running locally")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--open", action="store_true", help="open the browser after start")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    from pdfplume import engines
    from pdfplume.server import create_app

    port, addresses = choose_port(args.host, args.port)
    app = create_app()
    storage = app.extensions["pdfplume_storage"]
    storage.cleanup()
    storage.start_cleanup_thread()

    caps = engines.capabilities()
    local = args.host in ("0.0.0.0", "127.0.0.1", "localhost", "::")
    url = f"http://{'localhost' if local else args.host}:{port}"
    print("\n  PDFPlume is running at  " + url)
    print("  Optional engines:")
    for key, label in (("libreoffice", "LibreOffice (Office -> PDF)"),
                       ("ghostscript", "Ghostscript (compression, PDF/A)"),
                       ("tesseract", "Tesseract (OCR)")):
        print(f"    [{'x' if caps[key] else ' '}] {label}")
    print(f"    HTML to PDF engine: {caps['html_engine']}")
    print("  Press Ctrl+C to stop.\n")

    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    signal.signal(signal.SIGTERM, _stop)  # e.g. `kill`: stop the worker processes too
    try:
        try:
            from waitress import serve
        except ImportError:
            app.run(host=addresses[0], port=port, debug=args.debug, threaded=True, use_reloader=False)
        else:
            listen = " ".join(f"[{a}]:{port}" if ":" in a else f"{a}:{port}" for a in addresses)
            serve(app, listen=listen, threads=8, max_request_body_size=config.MAX_UPLOAD_MB * 1024 * 1024)
    except KeyboardInterrupt:
        pass
    finally:
        app.extensions["pdfplume_jobs"].shutdown(terminate=True)


def _stop(*_):
    raise KeyboardInterrupt


if __name__ == "__main__":
    main()
