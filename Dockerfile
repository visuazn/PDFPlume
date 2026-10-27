# PDFPlume with every optional engine (LibreOffice, Ghostscript, Tesseract, Chromium).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    PDFPLUME_HOST=0.0.0.0 PDFPLUME_PORT=8765 PDFPLUME_DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress \
        ghostscript \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-deu \
        tesseract-ocr-spa tesseract-ocr-ita tesseract-ocr-por \
        chromium \
        fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-cjk \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY pdfplume ./pdfplume
COPY run.py .

RUN mkdir -p /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health')"
CMD ["python", "run.py"]
