"""Receipt text -> the six petty-cash fields (pure parsing, no OCR needed)."""

from __future__ import annotations

from datetime import date

from app.modules.petty_cash.parser import parse_receipt

NEFT_SCREEN = """\
Payment initiated successfully
The transaction with Reference ID 2559007396 is
processed successfully.
6 Oct '26, 9:47 PM
Transaction reference no.- 2559007396
Payment to optimaprojectors
INDUSIND BANK LIMITED |
A/c: 2597 4177 7969
Amount ₹1,62,840.00
(Rupees one lakh sixty
two thousand eight hun...
Payment mode NEFT
Payment from 5915 0500 0085
LATIGID ENGINEERING
PRIVATE LIMITED
Remarks amruppaporter
.pdf
Back to home
Another payment
"""


def test_neft_confirmation_screen() -> None:
    p = parse_receipt(NEFT_SCREEN)
    assert p.transaction_id == "2559007396"
    assert p.txn_date == date(2026, 10, 6)
    assert p.payment_to == "optimaprojectors INDUSIND BANK LIMITED | A/c: 2597 4177 7969"
    assert p.amount == "162840.00"
    assert p.payment_from == "5915 0500 0085 LATIGID ENGINEERING PRIVATE LIMITED"
    assert p.remarks == "amruppaporter"
    assert set(p.found()) == {
        "transaction_id",
        "txn_date",
        "payment_to",
        "payment_from",
        "remarks",
        "amount",
    }


def test_upi_app_receipt_with_values_on_the_next_line() -> None:
    text = """\
Paid to
Sharma Traders
UPI Transaction ID
T2610061234567890
Paid from
HDFC Bank - 1234
Message
Office tea
06/10/2026
₹ 450
"""
    p = parse_receipt(text)
    assert p.transaction_id == "T2610061234567890"
    assert p.txn_date == date(2026, 10, 6)
    assert p.payment_to == "Sharma Traders"
    assert p.payment_from == "HDFC Bank - 1234"
    assert p.remarks == "Office tea"
    assert p.amount == "450.00"


def test_nothing_recognisable_gives_empty_fields() -> None:
    p = parse_receipt("hello world\nno receipt here")
    assert p.found() == []


def test_date_formats_and_invalid_dates() -> None:
    assert parse_receipt("Date: 2026-10-09").txn_date == date(2026, 10, 9)
    assert parse_receipt("on October 9, 2026").txn_date == date(2026, 10, 9)
    assert parse_receipt("31/02/2026").txn_date is None
    assert parse_receipt("9 Oct 2026").txn_date == date(2026, 10, 9)


def test_amount_forms() -> None:
    assert parse_receipt("Rs. 12,500").amount == "12500.00"
    assert parse_receipt("Amount: 99.50").amount == "99.50"
    assert parse_receipt("Total 1,23,456.78 paid").amount == "123456.78"
