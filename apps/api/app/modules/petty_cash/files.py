"""Receipt files: validation and text recognition.

A receipt is an image (PNG/JPG/WebP) or a PDF, at most 5 MB. The original bytes are stored as the
employer's evidence; nothing is re-encoded. Recognised text is only ever a PROPOSAL that the
employer reviews (ADR 0008).
"""

from __future__ import annotations

import contextlib
import io
from typing import cast

import pdfplumber
from fastapi import HTTPException
from PIL import Image, ImageStat, UnidentifiedImageError

from app.core.config import get_settings
from app.modules.imports.ocr import (
    OcrError,
    OcrProvider,
    OcrUnavailable,
    TesseractProvider,
    get_ocr_provider,
)
from app.modules.petty_cash.parser import ALT_MARK
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


def _span(profile: Image.Image, length: int) -> tuple[int, int] | None:
    """First and last position whose share of 'content' pixels is more than a speck (a stray dot
    or a notification badge in the corner must not count)."""
    values = profile.tobytes()  # mode "L": one byte per pixel
    hot = [i for i, v in enumerate(values) if v > 255 * 0.03]
    return (hot[0], hot[-1] + 1) if hot else None


def _crop_to_content(gray: Image.Image) -> Image.Image:
    """Drop a plain border (e.g. a phone screen shown on a black desktop): the text is then scaled
    by its own size, not by the size of the surrounding empty space."""
    last_x, last_y = gray.width - 1, gray.height - 1
    corners = [cast(int, gray.getpixel(p)) for p in ((0, 0), (last_x, 0), (0, last_y))]
    background = sorted(corners)[1]  # the median corner
    mask = gray.point(lambda v: 255 if abs(v - background) > 24 else 0)
    cols = _span(mask.resize((gray.width, 1), Image.Resampling.BOX), gray.width)
    rows = _span(mask.resize((1, gray.height), Image.Resampling.BOX), gray.height)
    if cols is None or rows is None:
        return gray
    pad = 12
    box = (
        max(0, cols[0] - pad),
        max(0, rows[0] - pad),
        min(gray.width, cols[1] + pad),
        min(gray.height, rows[1] + pad),
    )
    area = (box[2] - box[0]) * (box[3] - box[1])
    return gray.crop(box) if area < 0.9 * gray.width * gray.height else gray


def _is_light(gray: Image.Image) -> bool:
    return bool(ImageStat.Stat(gray).mean[0] >= 128)


def _darken_faint_text(gray: Image.Image) -> Image.Image:
    """Receipts print their labels in pale grey; Tesseract drops them. Push every non-white tone
    darker (a gamma curve) so the labels survive."""
    return gray.point([round(255 * (v / 255) ** 2) for v in range(256)])


def _scale(gray: Image.Image) -> Image.Image:
    if gray.width < OCR_MIN_WIDTH:
        scale = OCR_MIN_WIDTH / gray.width
        return gray.resize((OCR_MIN_WIDTH, round(gray.height * scale)), Image.Resampling.LANCZOS)
    if gray.width > OCR_MAX_WIDTH:
        scale = OCR_MAX_WIDTH / gray.width
        return gray.resize((OCR_MAX_WIDTH, round(gray.height * scale)), Image.Resampling.LANCZOS)
    return gray


def _prepare(image: Image.Image) -> Image.Image:
    """For PDF pages: crop, darken if light, scale."""
    gray = _crop_to_content(image.convert("L"))
    return _scale(_darken_faint_text(gray) if _is_light(gray) else gray)


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
    """The text on the image. Light receipts are read twice: once darkened (so pale grey labels
    survive) and once plain, which reads the rupee sign more kindly; the parser cross-checks the
    amount. Dark screens get a second look at the top banner, where UPI apps print the amount in
    large white-on-colour type that the main pass skips."""
    base = _crop_to_content(img.convert("L"))
    light = _is_light(base)
    text = provider.recognize(
        _scale(_darken_faint_text(base) if light else base), timeout=MAIN_TIMEOUT
    )
    extra = ""
    with contextlib.suppress(OcrError):  # the main pass already worked; this is a bonus
        if light:
            extra = provider.recognize(_scale(base), timeout=BANNER_TIMEOUT)
        else:
            gray = _scale(base)
            banner = gray.crop((0, 0, gray.width, int(gray.height * 0.25)))
            if isinstance(provider, TesseractProvider):
                extra = provider.recognize(banner, timeout=BANNER_TIMEOUT, psm=11)
            else:
                extra = provider.recognize(banner, timeout=BANNER_TIMEOUT)
    return f"{text}{ALT_MARK}{extra}" if extra else text


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
