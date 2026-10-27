"""Find a sheet of paper in a photo and flatten it (perspective correction).

Corners are fractions (0..1) of the photo, ordered top-left, top-right,
bottom-right, bottom-left.
"""

import cv2
import numpy as np
from PIL import Image

FULL = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]


def _order(pts):
    """Sort four points as top-left, top-right, bottom-right, bottom-left."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def _quads(gray):
    """Candidate four-sided outlines from edges and from brightness."""
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    med = float(np.median(blur))
    edges = cv2.Canny(blur, int(max(0, 0.66 * med)), int(min(255, 1.33 * med)))
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    _, bright = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    for mask in (edges, bright):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:6]:
            area = cv2.contourArea(c)
            if area < 0.15 * w * h:
                break
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            for eps in (0.02, 0.03, 0.045, 0.06):
                approx = cv2.approxPolyDP(hull, eps * peri, True)
                if len(approx) == 4 and cv2.isContourConvex(approx):
                    yield cv2.contourArea(approx) / (w * h), approx.reshape(4, 2)
                    break


def detect_document(image, max_side=900):
    """{"corners": [[x, y] * 4], "found": bool} for a PIL image."""
    im = image.convert("L")
    scale = min(1.0, max_side / max(im.size))
    if scale < 1:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    gray = np.asarray(im)
    h, w = gray.shape
    best = None
    for area, quad in _quads(gray):
        # A quad hugging the whole frame is usually the photo border, not a page.
        margin = np.minimum.reduce([quad[:, 0], w - 1 - quad[:, 0], quad[:, 1], h - 1 - quad[:, 1]])
        if area > 0.97 and margin.max() < 4:
            continue
        if best is None or area > best[0]:
            best = (area, quad)
    if best is None:
        return {"corners": FULL, "found": False}
    pts = _order(best[1]).astype(np.float64)
    pts += (pts.mean(axis=0) - pts) * 0.006  # step just inside the paper's edge
    return {"corners": [[round(float(x) / (w - 1), 4), round(float(y) / (h - 1), 4)] for x, y in pts], "found": True}


def _valid(corners):
    try:
        pts = np.asarray(corners, dtype=np.float32).reshape(4, 2)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(pts).all():
        return None
    return np.clip(pts, 0, 1)


def is_full(corners):
    pts = _valid(corners)
    return pts is None or np.abs(pts - np.asarray(FULL, dtype=np.float32)).max() < 0.004


def warp(image, corners):
    """Cut out the quadrilateral and stretch it into an upright rectangle."""
    pts = _valid(corners)
    if pts is None or is_full(corners):
        return image
    W, H = image.size
    src = _order(pts * np.array([W - 1, H - 1], dtype=np.float32))
    tl, tr, br, bl = src
    width = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    height = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    if width < 16 or height < 16:
        return image
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    mode = image.mode if image.mode in ("RGB", "L") else "RGB"
    arr = np.asarray(image.convert(mode))
    out = cv2.warpPerspective(arr, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(out, mode)
