"""PDF import: text/table PDFs, text-without-tables, scanned PDFs through OCR, and the limits."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.modules.imports import detect
from app.modules.imports.model import ImportFileError
from app.modules.imports.ocr import (
    OcrError,
    OcrProvider,
    OcrUnavailable,
    TesseractProvider,
    get_ocr_provider,
)
from app.modules.imports.pdf import lines_to_grid, read_pdf
from tests.conftest import Tenant, bearer
from tests.import_helpers import pdf_columns, pdf_table, pdf_text, scanned_pdf

MakeEmployer = Callable[[str], Tenant]

TABLE = [
    ["Party Name", "Mobile No", "Outstanding", "Invoice No", "Payment Due"],
    ["Rahul Sharma", "9876543210", "15,000.00", "INV-1001", "15/10/2026"],
    ["Priya Traders", "9876543211", "2,500.50", "INV-1002", "20/10/2026"],
    ["Amit Kumar", "9876543212", "8,500.00", "INV-1003", "25/10/2026"],
]
LINES = [
    "Rahul Sharma 9876543210 INV-1001 15,000.00 15/10/2026",
    "Priya Traders 98765 43211 INV-1002 2,500.50 20/10/2026",
    "Amit Kumar +91 9876543212 INV-1003 8500 25/10/2026",
]


class FakeOcr:
    """Stands in for Tesseract: returns the text 'seen' on every page."""

    def __init__(self, text: str = "") -> None:
        self.text = text
        self.pages = 0

    def recognize(self, image: Image.Image, *, timeout: float) -> str:
        self.pages += 1
        assert image.size[0] > 100
        return self.text


class BrokenOcr:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    def recognize(self, image: Image.Image, *, timeout: float) -> str:
        raise self.exc


@pytest.fixture
def with_ocr(client: TestClient) -> Iterator[Callable[[OcrProvider | None], None]]:
    def install(provider: OcrProvider | None) -> None:
        client.app.dependency_overrides[get_ocr_provider] = lambda: provider  # type: ignore[attr-defined]

    yield install
    client.app.dependency_overrides.clear()  # type: ignore[attr-defined]


# ------------------------------------------------------------------ text / table PDFs
def test_a_table_pdf_becomes_the_same_grid_as_excel() -> None:
    wb = read_pdf(pdf_table(TABLE), None)
    assert wb.kind == "pdf" and not wb.ocr
    assert wb.sheets[0].rows[0][0] == "Party Name"
    assert wb.sheets[0].rows[1][2] == "15,000.00"
    a = detect.analyze_sheet(wb.sheets[0])
    assert [a.mapping[f] for f in ("customer_name", "phone", "amount_due", "reference", "due_date")] == [
        0, 1, 2, 3, 4,
    ]  # fmt: skip
    assert wb.notes and "Check every row" in wb.notes[0]


def test_text_without_ruled_tables_is_split_by_its_visible_columns() -> None:
    wb = read_pdf(pdf_columns(TABLE), None)
    rows = wb.sheets[0].rows
    assert rows[0][:3] == ["Party Name", "Mobile No", "Outstanding"]
    assert rows[1][0] == "Rahul Sharma"


def test_plain_lines_of_text_are_picked_apart_into_columns() -> None:
    wb = read_pdf(pdf_text(["Outstanding statement", *LINES, "Page 1 of 1"]), None)
    rows = wb.sheets[0].rows
    assert rows[0] == ["Customer Name", "Phone Number", "Reference", "Amount Due", "Due Date"]
    assert rows[1] == ["Rahul Sharma", "9876543210", "INV-1001", "15,000.00", "15/10/2026"]
    assert rows[2][1] == "98765 43211" and rows[2][3] == "2,500.50"
    assert rows[3][1] == "+91 9876543212" and rows[3][3] == "8500"


def test_lines_to_grid_ignores_headings_and_page_numbers() -> None:
    grid = lines_to_grid(["Page 2", "Statement of dues", *LINES])
    assert grid is not None and len(grid) == 4


def test_a_pdf_with_nothing_usable_is_explained() -> None:
    with pytest.raises(ImportFileError, match="couldn't find customer names and amounts"):
        read_pdf(pdf_text(["Hello world, this is a letter about nothing in particular."] * 4), None)


# ------------------------------------------------------------------ limits and damage
def test_more_than_ten_pages_is_refused() -> None:
    with pytest.raises(ImportFileError, match="has 11 pages. The limit is 10"):
        read_pdf(pdf_text(LINES, pages=11), None)
    assert read_pdf(pdf_text(LINES, pages=10), None).sheets  # exactly the limit is fine


def test_damaged_and_fake_pdfs_are_refused_cleanly() -> None:
    for blob in (b"%PDF-1.4 this is not really a pdf", b"%PDF-", b"%PDF-1.7\n" + b"\x00" * 200):
        with pytest.raises(ImportFileError, match="damaged|PDF"):
            read_pdf(blob, None)


def test_a_slow_pdf_times_out_instead_of_hanging(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "pdf_timeout_seconds", -1)
    with pytest.raises(ImportFileError, match="taking too long"):
        read_pdf(pdf_text(LINES), None)


# ------------------------------------------------------------------ scanned PDFs (OCR)
def test_a_scanned_pdf_goes_through_the_ocr_provider_and_is_marked_as_ocr() -> None:
    ocr = FakeOcr("\n".join(LINES))
    wb = read_pdf(scanned_pdf(LINES), ocr)
    assert ocr.pages == 1
    assert wb.ocr is True
    assert wb.sheets[0].rows[1][0] == "Rahul Sharma"
    assert "scanned document" in wb.notes[0]


def test_every_page_of_a_scan_is_recognised() -> None:
    ocr = FakeOcr("\n".join(LINES))
    wb = read_pdf(scanned_pdf(LINES, pages=3), ocr)
    assert ocr.pages == 3
    assert len(wb.sheets[0].rows) == 1 + 3 * 3


def test_a_scan_without_an_ocr_provider_explains_what_to_do() -> None:
    with pytest.raises(ImportFileError, match="isn't turned on"):
        read_pdf(scanned_pdf(LINES), None)


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (OcrUnavailable("x"), "isn't available on this server"),
        (OcrError("x"), "couldn't read this scanned file clearly"),
        (RuntimeError("boom"), "couldn't read this scanned PDF"),
    ],
)
def test_ocr_failures_are_explained(exc: Exception, message: str) -> None:
    with pytest.raises(ImportFileError, match=message):
        read_pdf(scanned_pdf(LINES), BrokenOcr(exc))


def test_a_scan_that_yields_no_text_is_explained() -> None:
    with pytest.raises(ImportFileError, match="couldn't read any customer names"):
        read_pdf(scanned_pdf(LINES), FakeOcr("###  ~~~  \n\n"))


def test_scans_are_limited_to_ten_pages_before_any_recognition_starts() -> None:
    ocr = FakeOcr("\n".join(LINES))
    with pytest.raises(ImportFileError, match="limit is 10 pages"):
        read_pdf(scanned_pdf(LINES, pages=11), ocr)
    assert ocr.pages == 0


def test_the_tesseract_provider_fails_cleanly_when_it_is_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("shutil.which", lambda _name: None)
    with pytest.raises(OcrUnavailable):
        TesseractProvider().recognize(Image.new("L", (200, 100), 255), timeout=5)


def test_ocr_can_be_switched_off(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import get_settings

    get_ocr_provider.cache_clear()
    monkeypatch.setattr(get_settings(), "ocr_enabled", False)
    assert get_ocr_provider() is None
    get_ocr_provider.cache_clear()


@pytest.mark.skipif(not TesseractProvider.installed(), reason="Tesseract is not installed here")
def test_real_tesseract_reads_a_rendered_ledger() -> None:  # pragma: no cover - needs the binary
    from PIL import ImageDraw, ImageFont

    img = Image.new("L", (1400, 300), 255)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=28)
    for i, line in enumerate(LINES):
        draw.text((20, 20 + i * 60), line, fill=0, font=font)
    text = TesseractProvider().recognize(img, timeout=30)
    assert "Rahul" in text and "INV-1001" in text


# ------------------------------------------------------------------ through the API
def files(name: str, data: bytes) -> dict[str, Any]:
    return {"file": (name, data, "application/pdf")}


def test_analyze_and_preview_a_table_pdf_end_to_end(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    r = client.post("/api/v1/imports/analyze", files=files("dues.pdf", pdf_table(TABLE)), headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "pdf" and body["ocr"] is False
    assert {f["field"]: f["column"] for f in body["fields"]}["amount_due"] == 2
    p = client.post("/api/v1/imports/preview", files=files("dues.pdf", pdf_table(TABLE)), headers=h)
    assert p.status_code == 200, p.text
    assert [r["customer_name"] for r in p.json()["rows"]] == [
        "Rahul Sharma",
        "Priya Traders",
        "Amit Kumar",
    ]
    assert p.json()["rows"][0]["amount_due"] == "15000.00"
    assert p.json()["invalid"] == 0


def test_a_scanned_pdf_is_flagged_and_still_needs_review(
    client: TestClient,
    make_employer: MakeEmployer,
    with_ocr: Callable[[OcrProvider | None], None],
    admin_engine: Any,
) -> None:
    from sqlalchemy import text

    t = make_employer("a")
    h = bearer(t.auth_user_id)
    with_ocr(FakeOcr("\n".join(LINES)))
    r = client.post(
        "/api/v1/imports/preview", files=files("scan.pdf", scanned_pdf(LINES)), headers=h
    )
    assert r.status_code == 200, r.text
    assert r.json()["ocr"] is True
    assert any("scanned document" in n for n in r.json()["notes"])
    with admin_engine.connect() as c:  # recognised text is only a proposal: nothing is stored
        assert c.execute(text("SELECT count(*) FROM collections")).scalar_one() == 0
        assert c.execute(text("SELECT count(*) FROM customers")).scalar_one() == 0


def test_a_scanned_pdf_with_ocr_off_returns_a_clear_422(
    client: TestClient,
    make_employer: MakeEmployer,
    with_ocr: Callable[[OcrProvider | None], None],
) -> None:
    t = make_employer("a")
    with_ocr(None)
    r = client.post(
        "/api/v1/imports/analyze",
        files=files("scan.pdf", scanned_pdf(LINES)),
        headers=bearer(t.auth_user_id),
    )
    assert r.status_code == 422 and "isn't turned on" in r.json()["detail"]
