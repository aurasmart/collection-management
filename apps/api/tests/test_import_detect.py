"""Flexible column detection, mapping, normalisation and the review-ready rows."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import pytest

from app.modules.collections.rules import (
    parse_amount,
    parse_due_date,
    parse_phone,
    validate_row,
)
from app.modules.imports import detect
from app.modules.imports.model import FIELDS, Sheet


def sheet(rows: list[list[Any]]) -> Sheet:
    return Sheet("S", rows)


def mapping_of(rows: list[list[Any]]) -> dict[str, int | None]:
    return {str(k): v for k, v in detect.analyze_sheet(sheet(rows)).mapping.items()}


def status_of(rows: list[list[Any]]) -> dict[str, str]:
    return {f.name: f.status for f in detect.analyze_sheet(sheet(rows)).fields}


NAMES = ["Rahul Sharma", "Priya Traders", "Amit Kumar", "Asha Stores", "Zoya Mart"]
PHONES = ["9876543210", "98765 43211", "+91 98765 43212", "09876543213", "98765-43214"]
AMOUNTS = [15000, 2500.5, 8500, 120, 99999]


def table(headers: list[str], *cols: list[Any]) -> list[list[Any]]:
    return [headers, *[list(r) for r in zip(*cols, strict=True)]]


# ------------------------------------------------------------------ aliases
@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        (["Party Name", "Mobile No", "Outstanding", "Invoice No", "Payment Due"], [0, 1, 2, 3, 4]),
        (["Client", "Contact", "Balance Due", "Bill No", "Deadline"], [0, 1, 2, 3, 4]),
        (["Account Name", "Telephone", "Receivable", "Order Number", "Due On"], [0, 1, 2, 3, 4]),
        (
            ["Customer/Party", "Tel", "Total Outstanding", "Ref No", "Payment Deadline"],
            [0, 1, 2, 3, 4],
        ),
        (
            ["Company Name", "Phone No", "Net Amount", "Reference Number", "Due Date"],
            [0, 1, 2, 3, 4],
        ),
        (["Name", "Phone", "Pending Amount", "Invoice", "Due"], [0, 1, 2, 3, 4]),
    ],
)
def test_common_header_variations_are_recognised(headers: list[str], expected: list[int]) -> None:
    rows = table(headers, NAMES, PHONES, AMOUNTS, [f"INV-{i}" for i in range(5)],
                 ["15/10/2026", "16/10/2026", "17/10/2026", "18/10/2026", "19/10/2026"])  # fmt: skip
    a = detect.analyze_sheet(sheet(rows))
    assert [a.mapping[f] for f in FIELDS] == expected
    assert all(f.status == "detected" for f in a.fields), [(f.name, f.status) for f in a.fields]


def test_column_order_does_not_matter() -> None:
    rows = table(["Balance", "Client", "Mobile", "Invoice No"], AMOUNTS, NAMES, PHONES,
                 [f"A{i}" for i in range(5)])  # fmt: skip
    assert mapping_of(rows) == {
        "customer_name": 1, "phone": 2, "amount_due": 0, "reference": 3, "due_date": None,
    }  # fmt: skip


def test_typos_are_still_recognised_by_fuzzy_matching() -> None:
    rows = table(["Cutomer Nmae", "Ammount Due"], NAMES, AMOUNTS)
    assert mapping_of(rows)["customer_name"] == 0
    assert mapping_of(rows)["amount_due"] == 1


def test_headers_with_extra_words_still_match() -> None:
    rows = table(["Customer Name (as per ledger)", "Amount Due (INR)"], NAMES, AMOUNTS)
    assert mapping_of(rows)["customer_name"] == 0
    assert mapping_of(rows)["amount_due"] == 1


# ------------------------------------------------------------------ content signals
def test_unlabelled_columns_are_identified_by_their_contents() -> None:
    rows = table(["Col A", "Col B", "Col C", "Col D"], NAMES, PHONES,
                 AMOUNTS, ["15/10/2026", "16/10/2026", "17/10/2026", "18/10/2026", "19/10/2026"])  # fmt: skip
    a = detect.analyze_sheet(sheet(rows))
    m = a.mapping
    assert (m["phone"], m["due_date"]) == (1, 3)
    # contents alone are never trusted silently for name/amount: the employer confirms them
    assert {f.name: f.status for f in a.fields}["phone"] == "detected"
    assert {f.name: f.status for f in a.fields}["due_date"] == "detected"
    assert {f.name: f.status for f in a.fields}["customer_name"] == "uncertain"
    assert {f.name: f.status for f in a.fields}["amount_due"] == "uncertain"


def test_a_misleading_header_with_wrong_contents_is_flagged_not_trusted() -> None:
    rows = table(["Customer Name", "Amount Due"], PHONES, NAMES)  # swapped contents
    st = status_of(rows)
    assert st["customer_name"] != "detected"
    assert st["amount_due"] != "detected"


# ------------------------------------------------------------------ uncertainty
def test_two_amount_like_columns_are_uncertain_and_ask_the_employer() -> None:
    rows = table(["Customer", "Balance", "Net Amount"], NAMES, AMOUNTS, [a * 2 for a in AMOUNTS])
    a = detect.analyze_sheet(sheet(rows))
    amount = next(f for f in a.fields if f.name == "amount_due")
    assert amount.status == "uncertain"
    assert sorted([amount.column or 0, *amount.competing]) == [1, 2]
    assert any("Several columns could be the Amount Due" in n for n in a.notes)
    assert next(f for f in a.fields if f.name == "customer_name").status == "detected"


def test_missing_required_columns_are_reported_as_missing() -> None:
    rows = table(["Customer", "Notes"], NAMES, ["a", "b", "c", "d", "e"])
    st = status_of(rows)
    assert st["customer_name"] == "detected"
    assert st["amount_due"] == "missing"
    assert st["phone"] == st["reference"] == st["due_date"] == "missing"


def test_unmapped_columns_are_left_as_ignored() -> None:
    rows = table(["Customer", "Amount", "Salesman"], NAMES, AMOUNTS, ["x", "y", "z", "w", "v"])
    a = detect.analyze_sheet(sheet(rows))
    assert a.columns[2].suggested is None and a.columns[2].confidence == "none"


# ------------------------------------------------------------------ header rows
def test_title_rows_and_blank_rows_above_the_header_are_skipped() -> None:
    rows: list[list[Any]] = [["ACME TRADERS - Outstanding report"], [None], ["Printed 01/10/2026"], *table(
        ["Party Name", "Outstanding"], NAMES, AMOUNTS)]  # fmt: skip
    a = detect.analyze_sheet(sheet(rows))
    assert a.header_row == 3
    assert a.mapping["customer_name"] == 0 and a.mapping["amount_due"] == 1
    assert a.data_rows == 5


def test_a_sheet_without_a_header_row_is_handled() -> None:
    rows = [list(r) for r in zip(NAMES, PHONES, AMOUNTS, strict=True)]
    a = detect.analyze_sheet(sheet(rows))
    assert a.header_row is None
    assert a.mapping["phone"] == 1
    assert a.data_rows == 5


def test_the_best_sheet_is_chosen_automatically() -> None:
    summary = sheet([["Report", "Date"], ["Total", 5]])
    good = sheet(table(["Customer", "Outstanding"], NAMES, AMOUNTS))
    assert detect.best_sheet([summary, good]) == 1
    assert detect.best_sheet([good, summary]) == 0


# ------------------------------------------------------------------ building rows
def build(rows: list[list[Any]]) -> detect.BuiltRows:
    a = detect.analyze_sheet(sheet(rows))
    return detect.build_rows(sheet(rows), a, a.mapping)


def test_total_summary_and_repeated_header_rows_are_not_customers() -> None:
    rows: list[list[Any]] = [
        ["Party", "Outstanding"],
        ["Rahul", 100],
        [None, None],
        ["Party", "Outstanding"],
        ["Priya", 200],
        ["Sub Total", 300],
        ["Grand Total", 300],
        ["Total Outstanding", 300],
    ]
    built = build(rows)
    assert [r["customer_name"] for r in built.rows] == ["Rahul", "Priya"]
    reasons = {s.row_number: s.reason for s in built.skipped}
    assert reasons[4] == "Repeated heading"
    assert reasons[6] == reasons[7] == reasons[8] == "Total or summary row"


def test_real_spreadsheet_row_numbers_are_kept() -> None:
    rows: list[list[Any]] = [["Title"], ["Party", "Outstanding"], ["A", 1], [None, None], ["B", 2]]
    built = build(rows)
    assert [r["row_number"] for r in built.rows] == [3, 5]


def test_a_customer_called_total_something_is_not_confused_with_a_total_row() -> None:
    rows: list[list[Any]] = [
        ["Party", "Outstanding"],
        ["Totalcare Pharma", 100],
        ["Totally Fresh", 50],
    ]
    assert [r["customer_name"] for r in build(rows).rows] == ["Totalcare Pharma", "Totally Fresh"]


def test_row_limit() -> None:
    rows: list[list[Any]] = [["Party", "Amount"], *[[f"C{i}", i + 1] for i in range(2001)]]
    from app.modules.imports.model import ImportFileError

    with pytest.raises(ImportFileError, match="more than 2000"):
        build(rows)


# ------------------------------------------------------------------ dates
def test_slash_dates_that_could_be_either_order_are_flagged_for_confirmation() -> None:
    rows = table(["Customer", "Amount", "Due Date"], NAMES, AMOUNTS,
                 ["03/04/2026", "05/06/2026", "01/02/2026", "07/08/2026", "09/10/2026"])  # fmt: skip
    info = detect.analyze_sheet(sheet(rows)).columns[2].date_info
    assert info is not None and info.ambiguous and info.order == "dmy"
    assert info.examples[0] == "03/04/2026"


def test_one_unambiguous_date_settles_the_file_format() -> None:
    day_first = table(["C", "Amount", "Due Date"], NAMES, AMOUNTS,
                      ["03/04/2026", "25/06/2026", "01/02/2026", "07/08/2026", "09/10/2026"])  # fmt: skip
    info = detect.analyze_sheet(sheet(day_first)).columns[2].date_info
    assert info is not None and not info.ambiguous and info.order == "dmy"
    month_first = table(["C", "Amount", "Due Date"], NAMES, AMOUNTS,
                        ["03/04/2026", "06/25/2026", "01/02/2026", "07/08/2026", "09/10/2026"])  # fmt: skip
    info = detect.analyze_sheet(sheet(month_first)).columns[2].date_info
    assert info is not None and not info.ambiguous and info.order == "mdy"


def test_real_excel_dates_are_never_ambiguous() -> None:
    rows = table(["C", "Amount", "Due Date"], NAMES, AMOUNTS, [datetime(2026, 4, 3)] * 5)
    info = detect.analyze_sheet(sheet(rows)).columns[2].date_info
    assert info is not None and not info.ambiguous


def test_the_chosen_order_changes_how_a_slash_date_is_read() -> None:
    assert parse_due_date("03/04/2026", "dmy") == ("2026-04-03", None)
    assert parse_due_date("03/04/2026", "mdy") == ("2026-03-04", None)
    assert parse_due_date("13/04/2026", "dmy") == ("2026-04-13", None)
    assert parse_due_date("13/04/2026", "mdy")[1] is not None  # 13 is not a month: flagged


@pytest.mark.parametrize(
    ("value", "iso"),
    [
        ("15/10/2026", "2026-10-15"),
        ("15-10-2026", "2026-10-15"),
        ("15.10.2026", "2026-10-15"),
        ("2026-10-15", "2026-10-15"),
        ("2026-10-15 00:00:00", "2026-10-15"),
        ("15 Oct 2026", "2026-10-15"),
        ("15-Oct-2026", "2026-10-15"),
        ("Oct 15, 2026", "2026-10-15"),
        ("October 15, 2026", "2026-10-15"),
        (datetime(2026, 10, 15), "2026-10-15"),
        (date(2026, 10, 15), "2026-10-15"),
        (46310, "2026-10-15"),  # an Excel serial number
        (None, None),
        ("  ", None),
    ],
)
def test_date_formats(value: Any, iso: str | None) -> None:
    assert parse_due_date(value) == (iso, None)


@pytest.mark.parametrize("bad", ["not a date", "31/02/2026", "99/99/9999", "1999-01-01", "15/10"])
def test_bad_dates_are_flagged(bad: str) -> None:
    assert parse_due_date(bad)[1] == "Enter a valid date, like 15/10/2026"


# ------------------------------------------------------------------ phones
@pytest.mark.parametrize(
    "raw",
    [
        "+91 9876543210", "+919876543210", "9876543210", "09876543210", "98765 43210",
        "98765-43210", "(98765) 43210", "919876543210", 9876543210, 9876543210.0, "+91-98765-43210",
    ],
)  # fmt: skip
def test_indian_phone_formats_normalise_to_one_form(raw: Any) -> None:
    assert parse_phone(raw) == ("+919876543210", None)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("+44 7700 900123", "+447700900123"), ("+1 (415) 555-2671", "+14155552671")],
)
def test_international_numbers_are_kept_not_destroyed(raw: str, expected: str) -> None:
    assert parse_phone(raw) == (expected, None)


@pytest.mark.parametrize(
    "bad", ["12345", "5876543210", "98765abcde", "+91 5876543210", "+0123456789"]
)
def test_bad_phones_are_flagged_and_kept_as_typed(bad: str) -> None:
    value, error = parse_phone(bad)
    assert value == bad and error is not None


def test_blank_phone_is_allowed() -> None:
    assert parse_phone(None) == (None, None)
    assert parse_phone("  ") == (None, None)


# ------------------------------------------------------------------ amounts
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("₹15,000", "15000.00"), ("Rs 15,000", "15000.00"), ("Rs. 15,000", "15000.00"),
        ("15,000", "15000.00"), ("15000", "15000.00"), ("15,000.50", "15000.50"),
        ("₹15,000.50", "15000.50"), (15000, "15000.00"), (15000.5, "15000.50"),
        ("1,25,000", "125000.00"), ("INR 500", "500.00"), ("500/-", "500.00"), ("₹ 1 500", "1500.00"),
    ],
)  # fmt: skip
def test_amount_formats(raw: Any, expected: str) -> None:
    assert parse_amount(raw) == (expected, None)


@pytest.mark.parametrize("bad", ["-100", "(500)", "₹-5", 0, "0", -1])
def test_negative_and_zero_amounts_are_not_collectable(bad: Any) -> None:
    assert parse_amount(bad)[1] == "Amount must be greater than 0"


@pytest.mark.parametrize("bad", ["abc", "8,5OO", "1.2.3", "", None, "12345678901234"])
def test_unreadable_amounts_are_flagged(bad: Any) -> None:
    assert parse_amount(bad)[1] is not None


def test_validate_row_applies_the_chosen_date_order() -> None:
    raw = {"customer_name": "A", "amount_due": "1", "due_date": "03/04/2026"}
    assert validate_row(raw, "dmy").due_date == "2026-04-03"
    assert validate_row(raw, "mdy").due_date == "2026-03-04"
