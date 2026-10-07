"""Excel/CSV upload -> editable preview -> confirm. The server re-validates every row."""

from __future__ import annotations

import io
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import Engine, text

from app.modules.imports.parser import ImportFileError, parse_upload
from tests.conftest import Tenant, bearer

MakeEmployer = Callable[[str], Tenant]
HEADER: list[Any] = ["Customer Name", "Phone Number", "Amount Due", "Reference", "Due Date"]


def xlsx(rows: list[list[Any]], *, title_rows: int = 0) -> bytes:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    for _ in range(title_rows):
        ws.append(["Monthly dues report"])
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def csv_bytes(text_: str, encoding: str = "utf-8") -> bytes:
    return text_.encode(encoding)


GOOD: list[list[Any]] = [
    HEADER,
    ["Rahul Sharma", "9876543210", 15000, "INV-1001", date(2026, 10, 15)],
    ["Priya Traders", "98765 43211", "₹2,500.50", "INV-1002", "20/10/2026"],
    ["No Phone Co", None, 800, None, None],
]


# ------------------------------------------------------------------ parser
def test_reads_xlsx_with_real_excel_types() -> None:
    rows = parse_upload("dues.xlsx", xlsx(GOOD))
    assert [r["customer_name"] for r in rows] == ["Rahul Sharma", "Priya Traders", "No Phone Co"]
    assert rows[0]["due_date"] == __import__("datetime").datetime(2026, 10, 15)
    assert rows[0]["row_number"] == 2


def test_finds_the_header_below_title_rows_and_skips_blank_lines() -> None:
    data = xlsx([*GOOD[:3], [None] * 5, GOOD[3]], title_rows=2)
    rows = parse_upload("dues.xlsx", data)
    assert len(rows) == 3
    assert [r["row_number"] for r in rows] == [4, 5, 7]  # real spreadsheet row numbers


def test_column_order_and_common_synonyms_do_not_matter() -> None:
    data = xlsx([["Balance", "Client", "Mobile", "Invoice No"], [500, "Asha", "9876543210", "A1"]])
    (row,) = parse_upload("x.xlsx", data)
    assert (row["customer_name"], row["amount_due"], row["phone"], row["reference"]) == (
        "Asha", 500, "9876543210", "A1",
    )  # fmt: skip


def test_csv_variants() -> None:
    plain = "Customer Name,Phone Number,Amount Due\nRahul,9876543210,15000\n"
    assert parse_upload("a.csv", csv_bytes(plain))[0]["customer_name"] == "Rahul"
    bom = parse_upload("a.csv", csv_bytes(plain, "utf-8-sig"))
    assert bom[0]["customer_name"] == "Rahul"  # BOM does not break the first header
    semi = "Customer Name;Amount Due\nRahul;1,000\n".replace("1,000", "1000")
    assert parse_upload("a.csv", csv_bytes(semi))[0]["amount_due"] == "1000"
    legacy = "Customer Name,Amount Due\nJosé Traders,10\n"
    assert parse_upload("a.csv", csv_bytes(legacy, "cp1252"))[0]["customer_name"] == "José Traders"


@pytest.mark.parametrize(
    ("name", "data", "fragment"),
    [
        ("a.pdf", b"%PDF-1.4", "Excel .* and CSV"),
        ("a.docx", b"PK\x03\x04", "Excel .* and CSV"),
        ("a.xls", b"\xd0\xcf\x11\xe0", "Old .xls"),
        ("a.xlsx", b"this is not a zip", "real .xlsx"),
        ("a.csv", b"", "empty"),
        ("a.csv", b"Name,Foo\nx,y\n", "Customer Name and Amount Due"),
        ("a.csv", b"Customer Name,Amount Due\n", "no customer rows"),
        ("a.csv", b"x" * (5 * 1024 * 1024 + 1), "larger than 5 MB"),
    ],
)
def test_unusable_files_get_a_clear_message(name: str, data: bytes, fragment: str) -> None:
    with pytest.raises(ImportFileError, match=fragment):
        parse_upload(name, data)


def test_macro_workbooks_and_damaged_zips_are_refused() -> None:
    import zipfile

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("xl/vbaProject.bin", b"macro")
        z.writestr("[Content_Types].xml", "<x/>")
    with pytest.raises(ImportFileError, match="macros"):
        parse_upload("m.xlsx", out.getvalue())
    with pytest.raises(ImportFileError, match="damaged"):
        parse_upload("m.xlsx", b"PK\x03\x04garbage-that-is-not-a-zip")


def test_row_limit() -> None:
    many = "Customer Name,Amount Due\n" + "\n".join(f"C{i},{i + 1}" for i in range(2001))
    with pytest.raises(ImportFileError, match="more than 2000"):
        parse_upload("big.csv", csv_bytes(many))


# ------------------------------------------------------------------ endpoints
def preview(client: TestClient, t: Tenant, name: str, data: bytes) -> Any:
    return client.post(
        "/api/v1/imports/preview",
        files={"file": (name, data, "application/octet-stream")},
        headers=bearer(t.auth_user_id),
    )


def test_import_endpoints_need_a_signed_in_employer(client: TestClient) -> None:
    assert (
        client.post("/api/v1/imports/preview", files={"file": ("a.csv", b"x")}).status_code == 401
    )
    assert client.post("/api/v1/imports/validate", json={"rows": []}).status_code == 401
    assert client.post("/api/v1/imports/confirm", json={"rows": [{}]}).status_code == 401


def test_preview_returns_normalised_rows_and_flags_problems(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    bad = [HEADER, ["", "123", "abc", "R1", "nope"], ["Ok Co", "9876543210", 10, "R2", None]]
    r = preview(client, t, "x.xlsx", xlsx(bad))
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["total"], body["valid"], body["invalid"]) == (2, 1, 1)
    first, second = body["rows"]
    assert {e["field"] for e in first["errors"]} == {
        "customer_name",
        "phone",
        "amount_due",
        "due_date",
    }
    assert first["amount_due"] == "abc"  # the user's own text is kept so they can fix it
    assert second["errors"] == [] and second["phone"] == "+919876543210"
    assert second["amount_due"] == "10.00"


def test_preview_saves_nothing(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    preview(client, t, "x.xlsx", xlsx(GOOD))
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM collections")).scalar_one() == 0


def test_preview_rejects_bad_files_with_a_readable_message(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    r = preview(client, t, "report.pdf", b"%PDF-1.4")
    assert r.status_code == 422
    assert "Excel (.xlsx) and CSV" in r.json()["detail"]


def test_validate_rechecks_edited_rows(client: TestClient, make_employer: MakeEmployer) -> None:
    t = make_employer("a")
    r = client.post(
        "/api/v1/imports/validate",
        json={"rows": [{"customer_name": "Rahul", "phone": "98765 43210", "amount_due": "1,000"}]},
        headers=bearer(t.auth_user_id),
    )
    (row,) = r.json()
    assert (
        row["errors"] == [] and row["phone"] == "+919876543210" and row["amount_due"] == "1000.00"
    )


def confirm_body(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"filename": "dues.xlsx", "rows": rows}


def test_confirm_creates_customers_and_pending_collections(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    rows = [
        {
            "customer_name": "Rahul Sharma",
            "phone": "9876543210",
            "amount_due": "15000",
            "reference": "INV-1",
        },
        {"customer_name": "No Phone Co", "amount_due": "₹800", "due_date": "20/10/2026"},
    ]
    r = client.post(
        "/api/v1/imports/confirm", json=confirm_body(rows), headers=bearer(t.auth_user_id)
    )
    assert r.status_code == 200 and r.json() == {"imported": 2}
    with admin_engine.connect() as c:
        got = c.execute(
            text(
                "SELECT cu.name, cu.phone, c.amount_due, c.reference, c.due_date, c.status, "
                "c.payment_token, c.employer_id FROM collections c "
                "JOIN customers cu ON cu.id = c.customer_id ORDER BY cu.name"
            )
        ).all()
        audit = c.execute(
            text("SELECT action, details FROM audit_events WHERE entity_type='import'")
        ).one()
    assert [(g.name, g.phone, str(g.amount_due), g.status, g.payment_token) for g in got] == [
        ("No Phone Co", None, "800.00", "PENDING", None),
        ("Rahul Sharma", "+919876543210", "15000.00", "PENDING", None),
    ]
    assert all(g.employer_id == t.employer_id for g in got)
    assert got[0].due_date == date(2026, 10, 20)
    assert audit.action == "import_confirmed" and audit.details["customers"] == 2


def test_confirm_never_trusts_the_browser(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    """One bad row blocks the whole import: nothing is saved (all or nothing)."""
    t = make_employer("a")
    rows = [
        {"customer_name": "Good Co", "amount_due": "100"},
        {"customer_name": "Bad Co", "amount_due": "-5"},
    ]
    r = client.post(
        "/api/v1/imports/confirm", json=confirm_body(rows), headers=bearer(t.auth_user_id)
    )
    assert r.status_code == 422
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM collections")).scalar_one() == 0
        assert c.execute(text("SELECT count(*) FROM customers")).scalar_one() == 0


def test_confirm_rejects_empty_and_oversized_requests_and_unknown_fields(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    assert (
        client.post("/api/v1/imports/confirm", json=confirm_body([]), headers=h).status_code == 422
    )
    too_many = [{"customer_name": f"C{i}", "amount_due": "1"} for i in range(2001)]
    assert (
        client.post("/api/v1/imports/confirm", json=confirm_body(too_many), headers=h).status_code
        == 422
    )
    forged = {"customer_name": "X", "amount_due": "1", "employer_id": str(t.employer_id)}
    assert (
        client.post("/api/v1/imports/confirm", json=confirm_body([forged]), headers=h).status_code
        == 422
    )
    forged_top = {**confirm_body([{"customer_name": "X", "amount_due": "1"}]), "employer_id": "x"}
    assert client.post("/api/v1/imports/confirm", json=forged_top, headers=h).status_code == 422


def test_imports_land_only_in_the_callers_workspace(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    a, b = make_employer("a"), make_employer("b")
    client.post(
        "/api/v1/imports/confirm",
        json=confirm_body([{"customer_name": "Only A", "amount_due": "5"}]),
        headers=bearer(a.auth_user_id),
    )
    assert client.get("/api/v1/collections", headers=bearer(b.auth_user_id)).json()["total"] == 0
    assert client.get("/api/v1/collections", headers=bearer(a.auth_user_id)).json()["total"] == 1


def test_same_phone_twice_makes_two_independent_customers(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    rows = [
        {"customer_name": "Rahul", "phone": "9876543210", "amount_due": "10"},
        {"customer_name": "Rahul", "phone": "9876543210", "amount_due": "20"},
    ]
    r = client.post(
        "/api/v1/imports/confirm", json=confirm_body(rows), headers=bearer(t.auth_user_id)
    )
    assert r.json() == {"imported": 2}
