from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

import pytest

from app.modules.collections.rules import (
    parse_amount,
    parse_due_date,
    parse_name,
    parse_phone,
    parse_reference,
    validate_row,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("15000", "15000.00"),
        ("₹1,25,000", "125000.00"),
        ("Rs. 1,200.5", "1200.50"),
        ("INR 99", "99.00"),
        ("1500/-", "1500.00"),
        (15000, "15000.00"),
        (1234.567, "1234.57"),
        (Decimal("10.005"), "10.01"),
        ("0.01", "0.01"),
        (" 2 500 ", "2500.00"),
    ],
)
def test_amounts_are_cleaned(raw: Any, expected: str) -> None:
    assert parse_amount(raw) == (expected, None)


@pytest.mark.parametrize(
    "raw", [None, "", "abc", "0", "0.00", "-5", "(500)", "1e5", True, "12.3.4", "99999999999.00"]
)
def test_bad_amounts_are_rejected_with_the_users_text_kept(raw: Any) -> None:
    value, err = parse_amount(raw)
    assert err
    assert isinstance(value, str)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9876543210", "+919876543210"),
        ("98765 43210", "+919876543210"),
        ("+91 98765-43210", "+919876543210"),
        ("919876543210", "+919876543210"),
        ("09876543210", "+919876543210"),
        (9876543210, "+919876543210"),
        (9876543210.0, "+919876543210"),
        ("(98765) 43210", "+919876543210"),
        (None, None),
        ("", None),
        ("   ", None),
    ],
)
def test_phones_normalise_to_e164_india(raw: Any, expected: str | None) -> None:
    assert parse_phone(raw) == (expected, None)


@pytest.mark.parametrize(
    "raw", ["12345", "5876543210", "98765abcde", "98765432101", "+44 7700 900123"]
)
def test_bad_phones_are_rejected(raw: str) -> None:
    value, err = parse_phone(raw)
    assert err == "Enter a 10-digit Indian mobile number"
    assert value == raw


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("15/10/2026", "2026-10-15"),
        ("15-10-2026", "2026-10-15"),
        ("15.10.2026", "2026-10-15"),
        ("2026-10-15", "2026-10-15"),
        ("15 Oct 2026", "2026-10-15"),
        ("15 October 2026", "2026-10-15"),
        ("03/04/2026", "2026-04-03"),  # day first: 3 April
        (datetime(2026, 10, 15, 9, 30), "2026-10-15"),
        (date(2026, 10, 15), "2026-10-15"),
        (46310, "2026-10-15"),  # Excel serial
        (None, None),
        ("", None),
    ],
)
def test_dates_are_day_first(raw: Any, expected: str | None) -> None:
    assert parse_due_date(raw) == (expected, None)


@pytest.mark.parametrize(
    "raw", ["32/01/2026", "tomorrow", "13/13/2026", "01/01/1990", "2026-02-30", 12]
)
def test_bad_dates_are_rejected(raw: Any) -> None:
    assert parse_due_date(raw)[1]


def test_names_and_references() -> None:
    assert parse_name("  Rahul   Sharma ") == ("Rahul Sharma", None)
    assert parse_name("")[1] and parse_name(None)[1]
    assert parse_name("x" * 121)[1]
    assert parse_reference(1001.0) == ("1001", None)
    assert parse_reference("") == (None, None)
    assert parse_reference("r" * 61)[1]


def test_validate_row_collects_every_problem() -> None:
    r = validate_row(
        {
            "customer_name": "",
            "phone": "123",
            "amount_due": "abc",
            "due_date": "nope",
            "reference": "ok",
        }
    )
    assert [f for f, _ in r.errors] == ["customer_name", "phone", "amount_due", "due_date"]
    ok = validate_row(
        {
            "customer_name": "Rahul",
            "phone": "9876543210",
            "amount_due": "₹15,000",
            "reference": "INV-1",
        }
    )
    assert ok.errors == []
    assert (ok.phone, ok.amount_due, ok.due_date) == ("+919876543210", "15000.00", None)
