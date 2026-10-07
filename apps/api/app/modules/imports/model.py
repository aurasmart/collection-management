"""Shared types for the import pipeline: SOURCE -> grids -> detect -> map -> review -> import."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 2000
MAX_COLUMNS = 60
MAX_SHEETS = 20

Field = Literal["customer_name", "phone", "amount_due", "reference", "due_date"]
FIELDS: tuple[Field, ...] = ("customer_name", "phone", "amount_due", "reference", "due_date")
REQUIRED: tuple[Field, ...] = ("customer_name", "amount_due")
LABELS: dict[str, str] = {
    "customer_name": "Customer Name",
    "phone": "Phone Number",
    "amount_due": "Amount Due",
    "reference": "Reference",
    "due_date": "Due Date",
}

SourceKind = Literal["excel", "csv", "pdf", "google_sheets"]


class ImportFileError(Exception):
    """A problem with the source that the employer can fix; the message is safe to show."""


@dataclass
class Sheet:
    name: str
    rows: list[list[Any]]


@dataclass
class Workbook:
    """Every source (Excel, CSV, PDF, Google Sheets) becomes this one shape."""

    kind: SourceKind
    sheets: list[Sheet]
    ocr: bool = False  # the text was recognised from a scanned page: always double-check
    notes: list[str] = field(default_factory=list)
