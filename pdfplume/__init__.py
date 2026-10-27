"""PDFPlume - a private, offline PDF toolkit that runs on your own computer."""

import sys

__version__ = "2.1.0"

# PyMuPDF 2 loads an ONNX layout model whenever it is imported (about 1 s and
# 55 MB in every worker process). Only PDF to Markdown benefits from it, so it
# is loaded there on demand (see tools.convert_from.load_layout).
sys.modules.setdefault("pymupdf.layout", None)
