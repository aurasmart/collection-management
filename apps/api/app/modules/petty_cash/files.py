"""Receipt files: validation and text recognition.

A receipt is an image (PNG/JPG/WebP) or a PDF, at most 5 MB. The original bytes are stored as the
employer's evidence; nothing is re-encoded. Recognised text is only ever a PROPOSAL that the
employer reviews (ADR 0008).
"""

from __future__ import annotations

import contextlib
import io

import pdfplumber
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from app.core.config import get_settings
from app.modules.imports.ocr import (
    OcrError,
    OcrProvider,
    OcrUnavailable,
    TesseractProvider,
    get_ocr_provider,
)
from app.modules.settings.service import unprocessable

RECEIPT_MAX_BYTES = 5 * 1024 * 1024
OCR_PDF_PAGES = 3
OCR_MIN_WIDTH = 1000  # small screenshots are upscaled to this; Tesseract reads them better
OCR_MAX_WIDTH = 1200  # larger ones are shrunk: the free host's CPU is slow, time grows with pixels
MAIN_TIMEOUT = 50.0
BANNER_TIMEOUT = 25.0
_IMAGE_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
_PDF = "application/pdf"
_MIN_TEXT_CHARS = 40  # fewer than this on a PDF page => it is a scan, use OCR


def read_upload(raw: bytes) -> bytes:
    if not raw:
        raise unprocessable("file", "This file is empty")
    if len(raw) > RECEIPT_MAX_BYTES:
        raise unprocessable("file", "This file is larger than 5 MB")
    return raw


def check_receipt(data: bytes) -> str:
    """Return the content type of a valid receipt, judged by the bytes (never the file name)."""
    if data.startswith(b"%PDF-"):
        return _PDF
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            content_type = _IMAGE_TYPES.get(img.format or "")
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, ValueError):
        content_type = None
    if content_type is None:
        raise unprocessable("file", "Upload a PNG, JPG, WebP image or a PDF")
    return content_type


def clean_name(name: str | None) -> str | None:
    """Just the file's base name, trimmed; it is only shown back to the owner."""
    if not name:
        return None
    base = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    return base[:200] or None


def _prepare(image: Image.Image) -> Image.Image:
    gray = image.convert("L")
    if gray.width < OCR_MIN_WIDTH:
        scale = OCR_MIN_WIDTH / gray.width
        gray = gray.resize((OCR_MIN_WIDTH, round(gray.height * scale)), Image.Resampling.LANCZOS)
    elif gray.width > OCR_MAX_WIDTH:
        scale = OCR_MAX_WIDTH / gray.width
        gray = gray.resize((OCR_MAX_WIDTH, round(gray.height * scale)), Image.Resampling.LANCZOS)
    return gray


def receipt_text(data: bytes, content_type: str) -> str:
    """The text on the receipt. Raises OcrUnavailable / OcrError when it cannot be read."""
    if content_type == _PDF:
        return _pdf_text(data)
    provider = get_ocr_provider()
    if provider is None:
        raise OcrUnavailable("Text recognition is switched off")
    with Image.open(io.BytesIO(data)) as img:
        img.load()
        return _image_text(provider, img)


def _image_text(provider: OcrProvider, img: Image.Image) -> str:
    """The whole image, plus a second look at the top banner where UPI apps print the amount in
    large white-on-colour type that the main pass skips."""
    gray = _prepare(img)
    text = provider.recognize(gray, timeout=MAIN_TIMEOUT)
    banner = gray.crop((0, 0, gray.width, int(gray.height * 0.25)))
    with contextlib.suppress(OcrError):  # the main pass already worked; the banner is a bonus
        if isinstance(provider, TesseractProvider):
            text += "\n" + provider.recognize(banner, timeout=BANNER_TIMEOUT, psm=11)
        else:
            text += "\n" + provider.recognize(banner, timeout=BANNER_TIMEOUT)
    return text


def _timeout() -> float:
    return float(min(get_settings().pdf_timeout_seconds, 30))


def _pdf_text(data: bytes) -> str:
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = pdf.pages[:OCR_PDF_PAGES]
            texts = [(p.extract_text() or "") for p in pages]
            if sum(len(t.strip()) for t in texts) >= _MIN_TEXT_CHARS * max(1, len(pages)):
                return "\n".join(texts)
            provider = get_ocr_provider()
            if provider is None:
                raise OcrUnavailable("Text recognition is switched off")
            out = list(texts)
            for page in pages:
                image = page.to_image(resolution=200).original
                out.append(provider.recognize(_prepare(image), timeout=_timeout()))
            return "\n".join(out)
    except (OcrUnavailable, OcrError, HTTPException):
        raise
    except Exception:
        raise OcrError("Could not read this PDF") from None
