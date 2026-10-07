"""Text recognition for scanned PDFs, behind a small replaceable interface.

Tesseract is the first provider. It runs inside the request (no workers); every page has a time
limit. A different provider only has to implement `OcrProvider` and be returned by
`get_ocr_provider`. Recognised text is NEVER imported directly: it goes through the same
detect -> map -> review -> validate pipeline as every other source.
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from typing import Protocol

from PIL import Image

from app.core.config import get_settings


class OcrUnavailable(Exception):
    """No text recogniser is installed or enabled on this server."""


class OcrError(Exception):
    """Recognition failed or timed out for a page."""


class OcrProvider(Protocol):
    def recognize(self, image: Image.Image, *, timeout: float) -> str: ...


class TesseractProvider:
    def __init__(self, languages: str = "eng") -> None:
        self._languages = languages

    @staticmethod
    def installed() -> bool:
        return shutil.which("tesseract") is not None

    def recognize(self, image: Image.Image, *, timeout: float) -> str:
        import pytesseract

        if not self.installed():
            raise OcrUnavailable("Tesseract is not installed")
        try:
            # --psm 6: treat the page as one uniform block of rows, which suits ledgers and lists.
            return str(
                pytesseract.image_to_string(
                    image, lang=self._languages, config="--psm 6", timeout=max(1, int(timeout))
                )
            )
        except RuntimeError as exc:  # pytesseract raises RuntimeError("Tesseract process timeout")
            raise OcrError("Reading this page took too long") from exc
        except Exception as exc:  # corrupt image, language data missing, ...
            raise OcrError("Could not read this page") from exc


@lru_cache
def get_ocr_provider() -> OcrProvider | None:
    """The configured provider, or None when scanned-PDF reading is switched off."""
    settings = get_settings()
    if not settings.ocr_enabled:
        return None
    return TesseractProvider(settings.ocr_languages)
