"""Read an .xlsx or .csv upload into raw row dicts. Deliberately simple and predictable:
one sheet (the first), a header row, known column names, no guessing beyond a small synonym list."""

from __future__ import annotations

import csv
import io
import re
import zipfile
from typing import Any

from openpyxl import load_workbook

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 2000
MAX_UNZIPPED_BYTES = 50 * 1024 * 1024

# normalised header (lowercase, letters+digits only) -> our field
SYNONYMS: dict[str, tuple[str, ...]] = {
    "customer_name": (
        "customername",
        "customer",
        "name",
        "clientname",
        "client",
        "partyname",
        "party",
    ),
    "phone": (
        "phonenumber",
        "phone",
        "mobilenumber",
        "mobile",
        "mobileno",
        "phoneno",
        "contactnumber",
        "contact",
        "whatsapp",
    ),  # fmt: skip
    "amount_due": (
        "amountdue",
        "amount",
        "outstanding",
        "outstandingamount",
        "balance",
        "balancedue",
        "pendingamount",
        "due",
    ),  # fmt: skip
    "reference": ("reference", "referenceno", "ref", "invoice", "invoiceno", "invoicenumber"),
    "due_date": ("duedate", "paymentduedate"),
}
REQUIRED = ("customer_name", "amount_due")
FIELD_LABELS = {"customer_name": "Customer Name", "amount_due": "Amount Due"}


class ImportFileError(Exception):
    """A problem with the uploaded file that the employer can fix; the message is safe to show."""


def _key(header: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


def map_headers(cells: list[Any]) -> dict[str, int]:
    found: dict[str, int] = {}
    for idx, cell in enumerate(cells):
        k = _key(cell)
        if not k:
            continue
        for field, names in SYNONYMS.items():
            if field not in found and k in names:
                found[field] = idx
                break
    return found


def _rows_to_dicts(table: list[list[Any]]) -> list[dict[str, Any]]:
    header_at, mapping = None, {}
    for i, row in enumerate(table[:10]):
        m = map_headers(row)
        if all(r in m for r in REQUIRED):
            header_at, mapping = i, m
            break
    if header_at is None:
        seen = next((r for r in table[:10] if any(str(c or "").strip() for c in r)), [])
        names = ", ".join(str(c).strip() for c in seen if str(c or "").strip()) or "none"
        raise ImportFileError(
            "We couldn't find the Customer Name and Amount Due columns in the first rows. "
            f"Columns found: {names}. Expected: Customer Name, Phone Number, Amount Due, "
            "Reference, Due Date (optional)."
        )
    rows: list[dict[str, Any]] = []
    for offset, row in enumerate(table[header_at + 1 :], start=header_at + 2):
        values = {f: (row[i] if i < len(row) else None) for f, i in mapping.items()}
        if not any(str(v).strip() for v in values.values() if v is not None):
            continue  # blank line
        values["row_number"] = offset
        rows.append(values)
        if len(rows) > MAX_ROWS:
            raise ImportFileError(
                f"This file has more than {MAX_ROWS} rows. Split it and upload in parts."
            )
    if not rows:
        raise ImportFileError("We found the columns but no customer rows below them.")
    return rows


def _read_csv(data: bytes) -> list[list[Any]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    first = text.split("\n", 1)[0]
    delimiter = max(",;\t", key=first.count)
    return [list(r) for r in csv.reader(io.StringIO(text), delimiter=delimiter)]


def _read_xlsx(data: bytes) -> list[list[Any]]:
    if not data.startswith(b"PK\x03\x04"):
        raise ImportFileError(
            "This doesn't look like a real .xlsx file. Save it as Excel Workbook (.xlsx)."
        )
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            if sum(i.file_size for i in z.infolist()) > MAX_UNZIPPED_BYTES:
                raise ImportFileError("This spreadsheet is too large to read.")
    except zipfile.BadZipFile:
        raise ImportFileError(
            "This file seems damaged. Try re-saving it and uploading again."
        ) from None
    if any(n.lower().endswith("vbaproject.bin") for n in names):
        raise ImportFileError(
            "Spreadsheets with macros aren't supported. Save a copy as .xlsx without macros."
        )
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sheet = wb.worksheets[0]
        table = [list(r) for r in sheet.iter_rows(values_only=True, max_row=MAX_ROWS + 20)]
        wb.close()
    except ImportFileError:
        raise
    except Exception:
        raise ImportFileError(
            "We couldn't read this spreadsheet. It may be damaged or password-protected."
        ) from None
    return table


def parse_upload(filename: str, data: bytes) -> list[dict[str, Any]]:
    name = (filename or "").lower()
    if len(data) > MAX_FILE_BYTES:
        raise ImportFileError("This file is larger than 5 MB. Split it and upload in parts.")
    if not data:
        raise ImportFileError("This file is empty.")
    if name.endswith(".xlsx"):
        table = _read_xlsx(data)
    elif name.endswith(".csv"):
        table = _read_csv(data)
    elif name.endswith(".xls"):
        raise ImportFileError(
            "Old .xls files aren't supported. Save the file as .xlsx or .csv and try again."
        )
    else:
        raise ImportFileError(
            "We can read Excel (.xlsx) and CSV files. Please upload one of those."
        )
    return _rows_to_dicts(table)
