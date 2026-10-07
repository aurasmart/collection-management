"""File readers: Excel (.xlsx/.xls), CSV, limits and safety. Every source becomes the same grid."""

from __future__ import annotations

import io
import zipfile
from datetime import date, datetime

import pytest

from app.modules.imports.model import ImportFileError
from app.modules.imports.readers import read_workbook
from tests.import_helpers import GOOD, csv_bytes, xls, xlsx, xlsx_sheets


def test_xlsx_keeps_real_excel_types() -> None:
    wb = read_workbook("dues.xlsx", xlsx(GOOD))
    assert wb.kind == "excel"
    rows = wb.sheets[0].rows
    assert rows[0][0] == "Customer Name"
    assert rows[1][4] == datetime(2026, 10, 15)
    assert rows[1][2] == 15000


def test_every_visible_sheet_is_read_and_hidden_ones_are_ignored() -> None:
    data = xlsx_sheets(
        {"Summary": [["Total", 5]], "October": GOOD, "Secret": [["x"]]}, hidden=("Secret",)
    )
    wb = read_workbook("book.xlsx", data)
    assert [s.name for s in wb.sheets] == ["Summary", "October"]


def test_legacy_xls_is_read_including_dates_and_numbers() -> None:
    data = xls([GOOD[0], ["Rahul", "9876543210", 15000, "INV-1", date(2026, 10, 15)]])
    wb = read_workbook("old.xls", data)
    rows = wb.sheets[0].rows
    assert rows[1][0] == "Rahul"
    assert rows[1][2] == 15000
    assert rows[1][4] == datetime(2026, 10, 15)


def test_the_real_type_wins_over_the_extension() -> None:
    assert read_workbook("really-xlsx.xls", xlsx(GOOD)).kind == "excel"
    assert read_workbook("really-xls.xlsx", xls(GOOD)).kind == "excel"


def test_csv_variants() -> None:
    plain = "Customer Name,Phone Number,Amount Due\nRahul,9876543210,15000\n"
    assert read_workbook("a.csv", csv_bytes(plain)).sheets[0].rows[1][0] == "Rahul"
    bom = read_workbook("a.csv", csv_bytes(plain, "utf-8-sig"))
    assert bom.sheets[0].rows[0][0] == "Customer Name"  # BOM does not break the first header
    semi = read_workbook("a.csv", csv_bytes("Customer Name;Amount Due\nRahul;1000\n"))
    assert semi.sheets[0].rows[1] == ["Rahul", "1000"]
    tabs = read_workbook("a.csv", csv_bytes("Customer Name\tAmount Due\nRahul\t1000\n"))
    assert tabs.sheets[0].rows[1] == ["Rahul", "1000"]
    legacy = read_workbook(
        "a.csv", csv_bytes("Customer Name,Amount Due\nJosé Traders,10\n", "cp1252")
    )
    assert legacy.sheets[0].rows[1][0] == "José Traders"


@pytest.mark.parametrize(
    ("name", "data", "fragment"),
    [
        ("a.txt", b"hello", "Excel .*CSV and PDF"),
        ("a.docx", b"PK\x03\x04", "Excel .*CSV and PDF"),
        ("a.xlsx", b"this is not a zip", "real Excel"),
        ("a.xls", b"definitely not ole", "real Excel"),
        ("a.csv", b"", "empty"),
        ("a.csv", b"x" * (5 * 1024 * 1024 + 1), "larger than 5 MB"),
        ("a.csv", b"\x00\x01\x02binary", "real CSV"),
        ("a.xlsx", b"%PDF-1.4", "PDF"),
    ],
)
def test_unusable_files_get_a_clear_message(name: str, data: bytes, fragment: str) -> None:
    from app.modules.imports.sources import read_upload

    with pytest.raises(ImportFileError, match=fragment):
        read_upload(name, data, None)


def test_macro_workbooks_and_damaged_zips_are_refused() -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("xl/vbaProject.bin", b"macro")
        z.writestr("[Content_Types].xml", "<x/>")
    with pytest.raises(ImportFileError, match="macros"):
        read_workbook("m.xlsx", out.getvalue())
    with pytest.raises(ImportFileError, match="damaged"):
        read_workbook("m.xlsx", b"PK\x03\x04garbage-that-is-not-a-zip")


def test_zip_bombs_are_refused() -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/sheet.xml", b"0" * (60 * 1024 * 1024))
    assert len(out.getvalue()) < 5 * 1024 * 1024
    with pytest.raises(ImportFileError, match="too large"):
        read_workbook("bomb.xlsx", out.getvalue())


def test_an_empty_workbook_is_explained() -> None:
    with pytest.raises(ImportFileError, match="any data"):
        read_workbook("e.xlsx", xlsx([]))


def test_excel_text_escapes_become_real_characters() -> None:
    data = xlsx([["Party", "Balance"], ["SYED_x000D_\nSADIQ", 5], ["Plain_x_name", 6]])
    rows = read_workbook("e.xlsx", data).sheets[0].rows
    assert rows[1][0] == "SYED\r\nSADIQ"
    assert rows[2][0] == "Plain_x_name"  # only real _xHHHH_ escapes are decoded
