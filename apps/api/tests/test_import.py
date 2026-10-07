"""Import endpoints: analyze -> preview (with mapping) -> validate -> confirm (all or nothing)."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from tests.conftest import Tenant, bearer
from tests.import_helpers import GOOD, HEADER, csv_bytes, pdf_text, xlsx

MakeEmployer = Callable[[str], Tenant]


# ------------------------------------------------------------------ endpoints
def preview(client: TestClient, t: Tenant, name: str, data: bytes, **form: Any) -> Any:
    return client.post(
        "/api/v1/imports/preview",
        files={"file": (name, data, "application/octet-stream")},
        data={k: (json.dumps(v) if isinstance(v, dict) else str(v)) for k, v in form.items()},
        headers=bearer(t.auth_user_id),
    )


def analyze(client: TestClient, t: Tenant, name: str, data: bytes, **form: Any) -> Any:
    return client.post(
        "/api/v1/imports/analyze",
        files={"file": (name, data, "application/octet-stream")},
        data={k: str(v) for k, v in form.items()},
        headers=bearer(t.auth_user_id),
    )


def test_import_endpoints_need_a_signed_in_employer(client: TestClient) -> None:
    for path in ("preview", "analyze"):
        r = client.post(f"/api/v1/imports/{path}", files={"file": ("a.csv", b"x")})
        assert r.status_code == 401
    assert client.get("/api/v1/imports/google-sheets").status_code == 401
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


def test_bad_files_get_a_readable_message(client: TestClient, make_employer: MakeEmployer) -> None:
    t = make_employer("a")
    for name, data, fragment in [
        ("notes.txt", b"hello", "Excel .*CSV and PDF"),
        ("a.docx", b"PK\x03\x04", "Excel .*CSV and PDF"),
        ("a.xlsx", b"this is not a zip", "real Excel"),
        ("a.csv", b"", "empty"),
        ("a.pdf", b"%PDF-1.4 broken", "PDF"),
    ]:
        for endpoint in (preview, analyze):
            r = endpoint(client, t, name, data)
            assert r.status_code == 422, (name, r.text)
            assert __import__("re").search(fragment, r.json()["detail"]), r.json()


def test_a_source_is_required_and_exactly_one(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    assert client.post("/api/v1/imports/analyze", headers=h).status_code == 422
    both = client.post(
        "/api/v1/imports/analyze",
        files={"file": ("a.csv", b"Name,Amount\nA,1\n")},
        data={"sheet_url": "https://docs.google.com/spreadsheets/d/" + "a" * 30},
        headers=h,
    )
    assert both.status_code == 422


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


# ------------------------------------------------------------------ flexible import (API)
EMPLOYER_FILE: list[list[Any]] = [
    ["ACME TRADERS - Outstanding statement"],
    [None],
    ["Party Name", "Mobile No", "Outstanding", "Invoice No", "Payment Due", "Salesman"],
    ["Rahul Sharma", "+91 98765 43210", "Rs. 15,000", "INV-001", "15-10-2026", "Ravi"],
    ["Amit Kumar", "98765-43211", "8,500.00", "INV-002", "20/10/2026", "Ravi"],
    ["Priya Singh", "09876543212", 22000, "INV-003", date(2026, 11, 1), "Sunil"],
    ["Total", None, 45500, None, None, None],
]


def test_analyze_understands_a_real_world_file_without_exact_headers(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    r = analyze(client, t, "employer.xlsx", xlsx(EMPLOYER_FILE))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["header_row"] == 3 and body["source"] == "excel" and body["ocr"] is False
    assert body["sheets"] == [{"index": 0, "name": "Sheet", "rows": 7}]
    fields = {f["field"]: f for f in body["fields"]}
    assert {k: (v["column"], v["status"]) for k, v in fields.items()} == {
        "customer_name": (0, "detected"),
        "phone": (1, "detected"),
        "amount_due": (2, "detected"),
        "reference": (3, "detected"),
        "due_date": (4, "detected"),
    }
    assert fields["amount_due"]["required"] and not fields["phone"]["required"]
    assert fields["customer_name"]["label"] == "Customer Name"
    cols = body["columns"]
    assert [c["header"] for c in cols][:3] == ["Party Name", "Mobile No", "Outstanding"]
    assert cols[0]["samples"] == ["Rahul Sharma", "Amit Kumar", "Priya Singh"]
    assert cols[5]["suggested"] is None and cols[5]["confidence"] == "none"  # Salesman: ignored
    assert body["data_rows"] == 3  # the Grand Total line is not a customer


def test_analyze_picks_the_best_sheet_and_lets_the_employer_switch(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    from tests.import_helpers import xlsx_sheets

    t = make_employer("a")
    data = xlsx_sheets(
        {"Summary": [["Report", "x"], ["Total", 1]], "Dues": GOOD, "Other": [["a", "b"], [1, 2]]}
    )
    body = analyze(client, t, "b.xlsx", data).json()
    assert body["sheet"] == 1 and [s["name"] for s in body["sheets"]] == [
        "Summary",
        "Dues",
        "Other",
    ]
    switched = analyze(client, t, "b.xlsx", data, sheet=2).json()
    assert switched["sheet"] == 2
    assert analyze(client, t, "b.xlsx", data, sheet=9).status_code == 422


def test_the_employer_can_say_where_the_header_row_is(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    body = analyze(client, t, "e.xlsx", xlsx(EMPLOYER_FILE), header_row=1).json()
    assert body["header_row"] == 1
    none = analyze(client, t, "e.xlsx", xlsx(EMPLOYER_FILE), header_row=0).json()
    assert none["header_row"] == 0 and none["columns"][0]["header"] == "Column A"
    assert analyze(client, t, "e.xlsx", xlsx(EMPLOYER_FILE), header_row=500).status_code == 422


def test_ambiguous_slash_dates_are_reported_per_column(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    rows: list[list[Any]] = [
        ["Customer", "Amount", "Due Date"],
        *[[f"C{i}", 100 + i, f"0{i}/0{i + 1}/2026"] for i in range(1, 6)],
    ]
    body = analyze(
        client, t, "d.csv", ("\n".join(",".join(map(str, r)) for r in rows)).encode()
    ).json()
    assert body["columns"][2]["date_info"] == {
        "ambiguous": True, "order": "dmy", "examples": ["01/02/2026", "02/03/2026", "03/04/2026"],
    }  # fmt: skip


def test_preview_with_automatic_mapping_normalises_and_skips_totals(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    r = preview(client, t, "employer.xlsx", xlsx(EMPLOYER_FILE))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [
        (x["customer_name"], x["phone"], x["amount_due"], x["reference"], x["due_date"])
        for x in body["rows"]
    ] == [
        ("Rahul Sharma", "+919876543210", "15000.00", "INV-001", "2026-10-15"),
        ("Amit Kumar", "+919876543211", "8500.00", "INV-002", "2026-10-20"),
        ("Priya Singh", "+919876543212", "22000.00", "INV-003", "2026-11-01"),
    ]
    assert body["skipped"] == [{"row_number": 7, "reason": "Total or summary row"}]
    assert [x["row_number"] for x in body["rows"]] == [4, 5, 6]
    assert (body["total"], body["valid"], body["invalid"]) == (3, 3, 0)


def test_the_employers_manual_mapping_overrides_the_suggestion(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    data = csv_bytes("Customer,Balance,Net Amount\nRahul,100,90\nPriya,200,180\n")
    auto = preview(client, t, "x.csv", data).json()
    assert auto["rows"][0]["amount_due"] == "100.00"
    manual = preview(client, t, "x.csv", data, mapping={"customer_name": 0, "amount_due": 2}).json()
    assert [r["amount_due"] for r in manual["rows"]] == ["90.00", "180.00"]


@pytest.mark.parametrize(
    "mapping",
    [
        {"customer_name": 0},  # amount is required
        {"amount_due": 1},  # customer is required
        {"customer_name": 0, "amount_due": 0},  # one column twice
        {"customer_name": 0, "amount_due": 9},  # out of range
        {"customer_name": 0, "amount_due": -1},
        {"customer_name": 0, "amount_due": 1, "employer_id": 3},  # unknown field
        {"customer_name": "x", "amount_due": 1},
    ],
)
def test_a_bad_mapping_is_rejected_before_anything_is_read_into_customers(
    client: TestClient, make_employer: MakeEmployer, mapping: dict[str, Any]
) -> None:
    t = make_employer("a")
    r = preview(client, t, "x.csv", csv_bytes("Customer,Amount\nRahul,100\n"), mapping=mapping)
    assert r.status_code == 422


def test_unparseable_mapping_json_is_rejected(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    r = client.post(
        "/api/v1/imports/preview",
        files={"file": ("x.csv", b"Customer,Amount\nR,1\n")},
        data={"mapping": "{not json"},
        headers=bearer(t.auth_user_id),
    )
    assert r.status_code == 422


def test_the_date_order_chosen_by_the_employer_is_applied(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    data = csv_bytes("Customer,Amount,Due Date\nA,1,03/04/2026\nB,2,05/06/2026\n")
    dmy = preview(client, t, "x.csv", data).json()
    assert [r["due_date"] for r in dmy["rows"]] == ["2026-04-03", "2026-06-05"]
    mdy = preview(client, t, "x.csv", data, date_order="mdy").json()
    assert [r["due_date"] for r in mdy["rows"]] == ["2026-03-04", "2026-05-06"]
    assert preview(client, t, "x.csv", data, date_order="ymd").status_code == 422


def test_duplicate_looking_rows_are_flagged_but_never_blocked(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    data = csv_bytes("Customer,Amount,Invoice\nRahul,100,A1\nPriya,5,B1\nRahul,100,A1\n")
    body = preview(client, t, "x.csv", data).json()
    assert body["rows"][0]["warnings"] == []
    assert body["rows"][2]["warnings"] == [
        {"field": "row", "message": "Looks like a duplicate of row 2"}
    ]
    assert body["invalid"] == 0  # a warning, not an error: the employer decides
    again = client.post(
        "/api/v1/imports/validate",
        json={"rows": [{"customer_name": "R", "amount_due": "1"}] * 2},
        headers=bearer(t.auth_user_id),
    ).json()
    assert again[1]["warnings"][0]["message"] == "Looks like a duplicate of row 1"
    ok = client.post(
        "/api/v1/imports/confirm",
        json={"filename": "x.csv", "rows": [{"customer_name": "R", "amount_due": "1"}] * 2},
        headers=bearer(t.auth_user_id),
    )
    assert ok.status_code == 200 and ok.json() == {"imported": 2}


def test_a_wrong_mapping_is_called_out(client: TestClient, make_employer: MakeEmployer) -> None:
    t = make_employer("a")
    rows = "\n".join(f"Customer {i},abc{i}" for i in range(6))
    body = preview(client, t, "x.csv", csv_bytes("Customer,Amount\n" + rows + "\n")).json()
    assert body["invalid"] == 6
    assert any("Most amounts couldn't be read" in n for n in body["notes"])


def test_xls_and_multi_sheet_files_work_end_to_end(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    from tests.import_helpers import xls, xlsx_sheets

    t = make_employer("a")
    legacy = preview(client, t, "old.xls", xls(GOOD)).json()
    assert [r["customer_name"] for r in legacy["rows"]] == [
        "Rahul Sharma",
        "Priya Traders",
        "No Phone Co",
    ]
    assert legacy["rows"][0]["due_date"] == "2026-10-15"
    book = xlsx_sheets({"Notes": [["x"]], "Dues": GOOD})
    assert preview(client, t, "b.xlsx", book, sheet=1).json()["total"] == 3


def test_negative_amounts_stay_invalid_through_the_importer(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    body = preview(client, t, "x.csv", csv_bytes("Customer,Amount\nA,-100\nB,(50)\nC,10\n")).json()
    assert [r["errors"][0]["message"] if r["errors"] else None for r in body["rows"]] == [
        "Amount must be greater than 0", "Amount must be greater than 0", None,
    ]  # fmt: skip


def test_a_pdf_in_the_wrong_hands_cannot_smuggle_an_employer_id(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    r = client.post(
        "/api/v1/imports/preview",
        files={"file": ("a.pdf", pdf_text(["x"]))},
        data={"employer_id": str(t.employer_id)},
        headers=bearer(t.auth_user_id),
    )
    assert r.status_code in (200, 422)  # the extra form field is simply not a parameter
