"""One door for every source: uploaded file (Excel/CSV/PDF) or Google Sheet -> Workbook."""

from __future__ import annotations

from app.modules.imports.model import Workbook
from app.modules.imports.ocr import OcrProvider
from app.modules.imports.pdf import read_pdf
from app.modules.imports.readers import read_workbook, sniff


def read_upload(filename: str, data: bytes, ocr: OcrProvider | None) -> Workbook:
    if sniff(filename, data) == "pdf":
        return read_pdf(data, ocr)
    return read_workbook(filename, data)
