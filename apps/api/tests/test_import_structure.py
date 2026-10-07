"""Workbook STRUCTURE: titles, merged headings, accounting reports, ledgers, sections, no table."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.modules.imports import detect
from app.modules.imports.model import Sheet
from app.modules.imports.readers import read_workbook
from tests.conftest import Tenant, bearer
from tests.import_helpers import tally_group_summary, xlsx, xlsx_merged, xlsx_sheets

PARTIES: list[tuple[str, float | None, float | None]] = [
    ("Abrar Ahmed", 1716, None),
    ("Adette Electricals Private Limited", 31960, None),
    ("Air India Express Limited", None, 6712.99),
    ("Amar Radio Corporation", None, 2950),
    ("Amazon Seller Services Pvt Ltd", 4512.92, None),
    ("Ariss Technology Private Limited", None, 148149),
]


def analysis(
    rows: list[list[Any]], merges: list[tuple[int, int, int, int]] | None = None
) -> detect.SheetAnalysis:
    return detect.analyze_sheet(Sheet("S", rows, merges or []))


# ------------------------------------------------------------------ the accounting export
def test_a_tally_group_summary_is_understood_as_one_table_below_a_report_header() -> None:
    wb = read_workbook("creditors.xlsx", tally_group_summary(PARTIES))
    a = detect.analyze_sheet(wb.sheets[0])
    t = a.table
    assert t is not None and a.structure == "high"
    assert [r + 1 for r in t.header_rows] == [8, 9, 10, 11, 12]  # the merged heading band
    assert (t.data_rows[0] + 1, a.data_rows) == (13, len(PARTIES))  # the total is not a record
    assert t.leaf[0] == "Particulars" and t.leaf[1:3] == ["Debit", "Credit"]
    assert t.context[1] == t.context[2] == "Closing Balance"  # the merged group heading
    assert "Sundry Creditors" in t.title


def test_none_of_the_report_title_lines_become_customers() -> None:
    wb = read_workbook("c.xlsx", tally_group_summary(PARTIES))
    a = detect.analyze_sheet(wb.sheets[0])
    built = detect.build_rows(wb.sheets[0], a, {**a.mapping, "amount_due": 1})
    names = [r["customer_name"] for r in built.rows]
    assert "Example Traders Pvt Ltd, Pune" not in names and "Group Summary" not in names
    assert names == [
        "Abrar Ahmed",
        "Adette Electricals Private Limited",
        "Amazon Seller Services Pvt Ltd",
    ]


def test_debit_versus_credit_is_never_chosen_silently() -> None:
    wb = read_workbook("c.xlsx", tally_group_summary(PARTIES))
    a = detect.analyze_sheet(wb.sheets[0])
    amount = next(f for f in a.fields if f.name == "amount_due")
    assert (amount.status, amount.column, sorted(amount.competing)) == ("uncertain", None, [1, 2])
    assert (
        next(f for f in a.fields if f.name == "customer_name").status == "detected"
    )  # "Particulars"
    assert any("Debit" in n and "Credit" in n and "please choose" in n for n in a.notes)
    assert [c.header for c in a.columns][1:] == [
        "Closing Balance – Debit",
        "Closing Balance – Credit",
    ]


def test_the_side_the_employer_chooses_is_imported_and_the_other_side_is_listed_as_skipped() -> (
    None
):
    wb = read_workbook("c.xlsx", tally_group_summary(PARTIES))
    a = detect.analyze_sheet(wb.sheets[0])
    debit = detect.build_rows(wb.sheets[0], a, {**a.mapping, "amount_due": 1})
    assert [r["amount_due"] for r in debit.rows] == [1716, 31960, 4512.92]
    other = [s for s in debit.skipped if "not" in s.reason]
    assert len(other) == 3 and 'in "Closing Balance – Credit"' in other[0].reason
    assert {s.reason for s in debit.skipped} == {other[0].reason, "Total or summary row"}
    credit = detect.build_rows(wb.sheets[0], a, {**a.mapping, "amount_due": 2})
    assert [r["amount_due"] for r in credit.rows] == [6712.99, 2950, 148149]


def test_every_source_row_number_is_the_real_spreadsheet_row() -> None:
    wb = read_workbook("c.xlsx", tally_group_summary(PARTIES))
    a = detect.analyze_sheet(wb.sheets[0])
    built = detect.build_rows(wb.sheets[0], a, {**a.mapping, "amount_due": 1})
    assert [r["row_number"] for r in built.rows] == [13, 14, 17]


# ------------------------------------------------------------------ the requested structures
def test_1_a_normal_table_with_headings_in_row_1() -> None:
    a = analysis(
        [
            ["Customer", "Phone", "Amount Due"],
            ["Rahul", "9876543210", 100],
            ["Priya", "9876543211", 200],
        ]
    )
    assert a.table is not None and a.header_row == 0 and a.data_rows == 2
    assert {f.name: f.status for f in a.fields}["amount_due"] == "detected"


def test_2_title_company_date_blank_rows_then_headings_then_data() -> None:
    rows: list[list[Any]] = [
        ["ACME TRADERS PVT LTD"], ["12 Main Road, Pune"], ["Outstanding statement"], ["As on 07/10/2026"],
        [None], [None],
        ["Party Name", "Mobile", "Balance Due"],
        ["Rahul", "9876543210", 100], ["Priya", "9876543211", 200], ["Total", None, 300],
    ]  # fmt: skip
    a = analysis(rows)
    assert a.header_row == 6 and a.data_rows == 2
    assert a.mapping["customer_name"] == 0 and a.mapping["amount_due"] == 2


def test_3_merged_title_rows_and_a_merged_group_heading() -> None:
    rows: list[list[Any]] = [
        ["ACME TRADERS"], ["Customer dues"],
        ["Party", "Dues", None],
        [None, "Amount", "Date"],
        ["Rahul", 100, "15/10/2026"], ["Priya", 200, "16/10/2026"],
    ]  # fmt: skip
    a = analysis(rows, [(0, 0, 0, 2), (1, 0, 1, 2), (2, 1, 2, 2)])
    assert a.table is not None
    assert [r + 1 for r in a.table.header_rows] == [3, 4]
    assert a.table.leaf == ["Party", "Amount", "Date"] and a.table.context[1] == "Dues"
    assert (
        a.mapping["customer_name"] == 0
        and a.mapping["amount_due"] == 1
        and a.mapping["due_date"] == 2
    )


def test_4_party_debit_credit_balance_uses_the_balance_column() -> None:
    rows: list[list[Any]] = [
        ["Trial extract"],
        ["Party", "Debit", "Credit", "Balance"],
        ["Rahul", 500, None, 500], ["Priya", None, 300, 300], ["Amit", 100, None, 100],
    ]  # fmt: skip
    a = analysis(rows)
    st = {f.name: f for f in a.fields}
    assert st["amount_due"].column == 3 and st["amount_due"].status == "detected"
    assert not any("Debit" in n for n in a.notes)  # nothing to ask: the balance is clear


def test_5_a_ledger_with_repeated_headings_is_one_table_and_asks_for_the_balance() -> None:
    head: list[Any] = ["Date", "Particulars", "Debit", "Credit", "Balance"]
    rows: list[list[Any]] = [
        ["Ledger Account: Rahul Traders"], [None],
        head,
        ["01/04/2026", "Rahul Traders", 100, None, 100], ["05/04/2026", "Rahul Traders", None, 40, 60],
        ["09/04/2026", "Rahul Traders", 70, None, 130], ["12/04/2026", "Rahul Traders", None, 30, 100],
        ["Carried forward", None, None, None, 100],
        head,
        ["20/04/2026", "Rahul Traders", 10, None, 110], ["25/04/2026", "Rahul Traders", None, 5, 105],
        ["Grand Total", None, 180, 75, 105],
    ]  # fmt: skip
    a = analysis(rows)
    assert a.table is not None and len(a.tables) == 1  # NOT split into fake tables
    assert any(s[1] == "Repeated heading" for s in a.table.skipped)
    assert any("ledger/transaction report" in n for n in a.notes)
    amount = next(f for f in a.fields if f.name == "amount_due")
    assert amount.status == "uncertain" and amount.column is None  # never guessed, never summed
    built = detect.build_rows(Sheet("S", rows), a, {**a.mapping, "amount_due": 4})
    assert len(built.rows) == 6  # transactions stay transactions: nothing is aggregated for you
    assert {s.reason for s in built.skipped} >= {"Repeated heading", "Total or summary row"}


def test_6_several_sections_are_separate_tables() -> None:
    rows: list[list[Any]] = [
        ["Customers"],
        ["Party", "Balance"], ["Rahul", 100], ["Priya", 200], ["Amit", 300],
        [None],
        ["Suppliers"],
        ["Vendor name", "Payable", "Due date"], ["Zed Co", 50, "01/05/2026"], ["Yak Co", 60, "02/05/2026"],
    ]  # fmt: skip
    a = analysis(rows)
    assert len(a.tables) == 2 and a.notes[0].startswith("We found 2 tables")
    assert [t.records for t in a.tables] == [3, 2]
    assert a.table_index == 0 and a.mapping["amount_due"] == 1  # the better-matching table wins
    other = detect.analyze_sheet(Sheet("S", rows), "auto", 1)
    assert (
        other.table_index == 1 and other.table is not None and other.table.leaf[0] == "Vendor name"
    )
    assert [t.title for t in a.tables] == ["Customers", "Suppliers"]


def test_7_the_best_of_several_sheets_is_chosen() -> None:
    wb = read_workbook(
        "b.xlsx",
        xlsx_sheets(
            {
                "Cover": [["Report"], ["Prepared by"]],
                "Dues": [["Party", "Balance"], ["Rahul", 100], ["Priya", 200]],
                "Notes": [["Remember to follow up"]],
            }
        ),
    )
    assert detect.best_sheet(wb.sheets) == 1


def test_8_no_usable_customer_table_fails_gracefully_without_guessing() -> None:
    paragraphs: list[list[Any]] = [
        ["Minutes of the meeting held on Monday"], ["We discussed the quarterly plan."], ["Next steps were agreed."],
    ]  # fmt: skip
    a = analysis(paragraphs)
    assert a.table is None and a.structure == "low" and a.columns == []
    assert all(f.status == "missing" for f in a.fields)  # no "Column A = Customer" invention
    assert a.notes == ["We couldn't confidently identify the table structure."]
    assert analysis([]).table is None


def test_a_manual_heading_row_overrides_detection() -> None:
    rows: list[list[Any]] = [["x"], ["Party", "Balance"], ["Rahul", 100], ["Priya", 200]]
    a = detect.analyze_sheet(Sheet("S", rows), 1)
    assert a.header_row == 1 and a.mapping["amount_due"] == 1 and a.data_rows == 2
    none = detect.analyze_sheet(Sheet("S", rows), None)
    assert none.header_row is None


def test_a_table_that_continues_after_a_stray_line_is_not_split() -> None:
    rows: list[list[Any]] = [
        ["Party", "Balance"], ["Rahul", 100], ["Priya", 200], ["see next page"], ["Amit", 300], ["Zoya", 400],
    ]  # fmt: skip
    a = analysis(rows)
    assert len(a.tables) == 1 and a.data_rows == 4
    assert a.table is not None and (3, "Not a customer row") in a.table.skipped


# ------------------------------------------------------------------ through the API
def post(client: TestClient, t: Tenant, endpoint: str, data: bytes, **form: Any) -> Any:
    return client.post(
        f"/api/v1/imports/{endpoint}",
        files={"file": ("report.xlsx", data)},
        data={k: str(v) for k, v in form.items()},
        headers=bearer(t.auth_user_id),
    )


def test_api_reports_the_detected_table_and_its_headings(
    client: TestClient, make_employer: Any
) -> None:
    t = make_employer("a")
    body = post(client, t, "analyze", tally_group_summary(PARTIES)).json()
    assert body["structure"] == "high" and body["table"] == 0
    assert body["tables"][0]["header_rows"] == [8, 12]
    assert (
        body["tables"][0]["first_row"],
        body["tables"][0]["last_row"],
        body["tables"][0]["records"],
    ) == (13, 19, 6)
    assert body["header_row"] == 12 and body["data_rows"] == 6
    amount = next(f for f in body["fields"] if f["field"] == "amount_due")
    assert (amount["status"], amount["column"], sorted(amount["competing"])) == (
        "missing",
        None,
        [1, 2],
    ) or amount["status"] == "uncertain"


def test_api_previews_the_chosen_side_and_lists_what_was_skipped(
    client: TestClient, make_employer: Any
) -> None:
    import json

    t = make_employer("a")
    r = post(
        client,
        t,
        "preview",
        tally_group_summary(PARTIES),
        mapping=json.dumps({"customer_name": 0, "amount_due": 1}),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["customer_name"] for x in body["rows"]] == [
        "Abrar Ahmed", "Adette Electricals Private Limited", "Amazon Seller Services Pvt Ltd"
    ]  # fmt: skip
    assert [x["amount_due"] for x in body["rows"]] == ["1716.00", "31960.00", "4512.92"]
    assert len(body["skipped"]) == 4  # three credit-side parties + the Grand Total
    assert body["invalid"] == 0


def test_api_without_a_choice_for_amount_asks_instead_of_guessing(
    client: TestClient, make_employer: Any
) -> None:
    t = make_employer("a")
    r = post(client, t, "preview", tally_group_summary(PARTIES))
    assert r.status_code == 422 and "Amount Due" in r.json()["detail"]


def test_api_no_table_is_a_calm_answer_not_an_error(client: TestClient, make_employer: Any) -> None:
    t = make_employer("a")
    data = xlsx([["Minutes of the meeting"], ["We discussed the plan."]])
    body = post(client, t, "analyze", data).json()
    assert body["table"] is None and body["structure"] == "low" and body["columns"] == []
    assert "couldn't confidently identify the table structure" in body["notes"][0]
    assert post(client, t, "preview", data).status_code == 422


def test_api_table_choice_and_merged_headings_via_xlsx(
    client: TestClient, make_employer: Any
) -> None:
    t = make_employer("a")
    rows: list[list[Any]] = [
        ["Customers"], ["Party", "Balance"], ["Rahul", 100], ["Priya", 200],
        [None], ["Suppliers"], ["Vendor", "Payable"], ["Zed", 5], ["Yak", 6],
    ]  # fmt: skip
    data = xlsx_merged(rows, ["A1:B1", "A6:B6"])
    body = post(client, t, "analyze", data).json()
    assert [x["title"] for x in body["tables"]] == ["Customers", "Suppliers"]
    second = post(client, t, "analyze", data, table=1).json()
    assert second["table"] == 1 and second["columns"][0]["header"] == "Vendor"
    pv = post(client, t, "preview", data, table=1).json()
    assert [r["customer_name"] for r in pv["rows"]] == ["Zed", "Yak"]


@pytest.mark.parametrize("bad", ["-1", "99"])
def test_api_an_unknown_table_number_falls_back_to_the_best_one(
    client: TestClient, make_employer: Any, bad: str
) -> None:
    t = make_employer("a")
    data = xlsx([["Party", "Balance"], ["Rahul", 100], ["Priya", 200]])
    assert post(client, t, "analyze", data, table=bad).json()["table"] == 0
