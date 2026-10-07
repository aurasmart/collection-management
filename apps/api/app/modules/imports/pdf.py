"""PDF -> Workbook (the same grid shape Excel produces).

Text/table PDFs: tables are read directly. PDFs with text but no ruled tables are split into
columns by their spacing. Scanned PDFs (no text layer) go through the OCR provider. Whatever
comes out is only a PROPOSAL: it is detected, mapped, reviewed and validated like every other
source before anything is imported.
"""

from __future__ import annotations

import io
import re
import time
from typing import Any

import pdfplumber

from app.core.config import get_settings
from app.modules.imports.model import MAX_COLUMNS, ImportFileError, Sheet, Workbook
from app.modules.imports.ocr import OcrError, OcrProvider, OcrUnavailable

MIN_TEXT_CHARS_PER_PAGE = 25  # fewer than this on average => treat the PDF as scanned
OCR_RESOLUTION = 200  # DPI: a good accuracy/speed balance for printed ledgers

_PHONE_TOKEN = re.compile(r"(?<![\d.])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])")
_DATE_TOKEN = re.compile(
    r"(?<![\d/])\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}(?![\d/])|\d{4}-\d{2}-\d{2}"
    r"|\d{1,2}[ -](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ -,]*\d{2,4}",
    re.I,
)
_REF_TOKEN = re.compile(r"\b[A-Za-z]{1,6}[-/#]?\d{2,}[A-Za-z0-9/-]*\b|\b\d{2,}[-/][A-Za-z0-9/-]+\b")
_MONEY_TOKEN = re.compile(
    r"(?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?|(?<![\w/-])\d[\d,]*\.\d{1,2}(?![\w/-])|(?<![\w/.-])\d{1,3}(?:,\d{2,3})+(?![\w/-])|(?<![\w/.-])\d{3,9}(?![\w/-])"
)
_NOISE_LINE = re.compile(r"^\s*(page\s*\d+(\s*(of|/)\s*\d+)?|\d+\s*/\s*\d+)\s*$", re.I)


def _clean_cell(v: Any) -> str | None:
    if v is None:
        return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    return s or None


def _tables_to_sheets(tables: list[list[list[str | None]]]) -> list[Sheet]:
    groups: list[list[list[Any]]] = []
    widths: list[int] = []
    for t in tables:
        rows = [[_clean_cell(c) for c in r] for r in t]
        rows = [r for r in rows if any(r)]
        if len(rows) < 2:
            continue
        width = max(len(r) for r in rows)
        if width < 2:
            continue
        if widths and widths[-1] == width:
            groups[-1].extend(rows)  # the same table continuing on the next page
        else:
            groups.append(rows)
            widths.append(width)
    out: list[Sheet] = []
    for i, rows in enumerate(groups, start=1):
        name = "PDF table" if len(groups) == 1 else f"PDF table {i}"
        out.append(Sheet(name, [r[:MAX_COLUMNS] for r in rows]))
    return out


# ---------------------------------------------------------------- text lines -> grid
def _split_columns(line: str) -> list[str]:
    return [c.strip() for c in re.split(r"\t+|\s{2,}|\s\|\s", line.strip()) if c.strip()]


def lines_to_grid(lines: list[str]) -> list[list[Any]] | None:
    """Turn text lines into rows. First by visible columns, then by recognising the pieces."""
    lines = [ln for ln in (ln.strip() for ln in lines) if ln and not _NOISE_LINE.match(ln)]
    if not lines:
        return None
    split = [_split_columns(ln) for ln in lines]
    multi = [r for r in split if len(r) >= 3]
    if len(multi) >= max(2, int(0.6 * len(lines))):
        return [r[:MAX_COLUMNS] for r in split if len(r) >= 2]
    return _token_grid(lines)


def _token_grid(lines: list[str]) -> list[list[Any]] | None:
    rows: list[list[str | None]] = []
    for ln in lines:
        rest = ln
        phone = _take(_PHONE_TOKEN, rest)
        if phone:
            rest = rest.replace(phone, " ", 1)
        date = _take(_DATE_TOKEN, rest)
        if date:
            rest = rest.replace(date, " ", 1)
        ref = _take(_REF_TOKEN, rest)
        if ref:
            rest = rest.replace(ref, " ", 1)
        money = _MONEY_TOKEN.findall(rest)
        amount = money[-1] if money else None
        if amount is None:
            continue  # a heading, a note, or a line we cannot use
        rest = rest.replace(amount, " ", 1)
        name = re.sub(r"[^\w .&'/()-]", " ", rest)
        name = re.sub(r"\s+", " ", name).strip(" -.,:;|")
        if not name or not re.search(r"[A-Za-z]{2}", name):
            continue
        rows.append([name, phone, ref, amount, date])
    if len(rows) < 1:
        return None
    header = ["Customer Name", "Phone Number", "Reference", "Amount Due", "Due Date"]
    keep = [i for i in range(5) if any(r[i] for r in rows)]
    return [[header[i] for i in keep], *[[r[i] for i in keep] for r in rows]]


def _take(pattern: re.Pattern[str], text: str) -> str | None:
    m = pattern.search(text)
    return m.group(0).strip() if m else None


# ---------------------------------------------------------------- the reader
def read_pdf(data: bytes, ocr: OcrProvider | None) -> Workbook:
    settings = get_settings()
    deadline = time.monotonic() + settings.pdf_timeout_seconds
    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise _open_error(exc) from None
    with pdf:
        pages = pdf.pages
        if not pages:
            raise ImportFileError("This PDF has no pages.")
        if len(pages) > settings.pdf_max_pages:
            raise ImportFileError(
                f"This PDF has {len(pages)} pages. The limit is {settings.pdf_max_pages} pages. "
                "Split it and upload in parts."
            )
        tables: list[list[list[str | None]]] = []
        texts: list[str] = []
        try:
            for page in pages:
                _check_time(deadline)
                tables.extend(page.extract_tables())
                texts.append(page.extract_text(layout=True) or "")
        except ImportFileError:
            raise
        except Exception:
            raise ImportFileError(
                "We couldn't read this PDF. It may be damaged. Try saving it again."
            ) from None
        sheets = _tables_to_sheets(tables)
        if sheets:
            return Workbook("pdf", sheets, notes=_PDF_NOTES)
        chars = sum(len(t.strip()) for t in texts)
        if chars >= MIN_TEXT_CHARS_PER_PAGE * len(pages):
            grid = lines_to_grid([ln for t in texts for ln in t.splitlines()])
            if grid:
                return Workbook("pdf", [Sheet("PDF text", grid)], notes=_PDF_NOTES)
            raise ImportFileError(
                "We couldn't find customer names and amounts in this PDF. "
                "If it is a table, an Excel or CSV export of the same data will work best."
            )
        return _read_scanned(pages, ocr, deadline)


_PDF_NOTES = [
    "Read from a PDF. Check every row against your document before importing.",
]


def _read_scanned(pages: list[Any], ocr: OcrProvider | None, deadline: float) -> Workbook:
    if ocr is None:
        raise ImportFileError(
            "This PDF is a scan, and reading scanned documents isn't turned on for this account. "
            "Upload an Excel or CSV version instead."
        )
    lines: list[str] = []
    try:
        for page in pages:
            remaining = _check_time(deadline)
            image = page.to_image(resolution=OCR_RESOLUTION).original.convert("L")
            lines.extend(ocr.recognize(image, timeout=min(remaining, 30)).splitlines())
    except ImportFileError:
        raise
    except OcrUnavailable:
        raise ImportFileError(
            "This PDF is a scan, and the text-recognition tool isn't available on this server. "
            "Upload an Excel or CSV version instead."
        ) from None
    except OcrError:
        raise ImportFileError(
            "We couldn't read this scanned file clearly. Try a clearer scan or an Excel/CSV copy."
        ) from None
    except Exception:
        raise ImportFileError("We couldn't read this scanned PDF. Try a clearer scan.") from None
    grid = lines_to_grid(lines)
    if not grid:
        raise ImportFileError(
            "We couldn't read any customer names and amounts from this scan. "
            "Try a clearer scan or upload an Excel/CSV version."
        )
    return Workbook(
        "pdf",
        [Sheet("Scanned PDF", grid)],
        ocr=True,
        notes=[
            "This file was read from a scanned document using text recognition. Values may be "
            "misread: check every row against your document before importing."
        ],
    )


def _check_time(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ImportFileError(
            "This PDF is taking too long to read. Try fewer pages, or upload an Excel/CSV copy."
        )
    return remaining


def _open_error(exc: Exception) -> ImportFileError:
    name = type(exc).__name__
    if "Password" in name or "Encrypted" in name or "password" in str(exc).lower():
        return ImportFileError("This PDF is password-protected. Remove the password and try again.")
    return ImportFileError("This PDF seems damaged or isn't a real PDF. Try saving it again.")
