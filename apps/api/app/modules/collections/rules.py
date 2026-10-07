"""Field rules shared by the importer and the customer editor (one place, India/INR defaults).

Each parser returns (normalized value, error message). A value that cannot be parsed comes back
as the user's own text so the review screen can show it and let them fix it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

MAX_AMOUNT = Decimal("9999999999.99")  # numeric(12,2)
PHONE_RE = re.compile(r"^[6-9][0-9]{9}$")
_DATE_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y", "%d/%m/%y")
_EXCEL_EPOCH = date(1899, 12, 30)


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return re.sub(r"\s+", " ", str(v)).strip()


def parse_name(v: Any) -> tuple[str, str | None]:
    s = _text(v)
    if not s:
        return s, "Enter the customer name"
    if len(s) > 120:
        return s, "Name must be 120 characters or fewer"
    return s, None


def parse_phone(v: Any) -> tuple[str | None, str | None]:
    """Blank is allowed (only WhatsApp/SMS need a phone). Otherwise +91 followed by 10 digits."""
    s = _text(v)
    if not s:
        return None, None
    digits = re.sub(r"[\s\-()+.]", "", s)
    if not digits.isdigit():
        return s, "Enter a 10-digit Indian mobile number"
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not PHONE_RE.match(digits):
        return s, "Enter a 10-digit Indian mobile number"
    return f"+91{digits}", None


def parse_amount(v: Any) -> tuple[str, str | None]:
    if isinstance(v, bool):
        return _text(v), "Amount isn't a valid number"
    raw = format(Decimal(str(v)), "f") if isinstance(v, int | float | Decimal) else _text(v)
    cleaned = re.sub(r"(?i)(₹|rs\.?|inr|/-|,|\s)", "", raw)
    if not cleaned:
        return raw, "Enter the amount due"
    if cleaned.startswith("-") or (cleaned.startswith("(") and cleaned.endswith(")")):
        return raw, "Amount must be greater than 0"
    if not re.fullmatch(r"\d+(\.\d+)?", cleaned):
        return raw, "Amount isn't a valid number"
    try:
        amount = Decimal(cleaned).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return raw, "Amount isn't a valid number"
    if amount <= 0:
        return raw, "Amount must be greater than 0"
    if amount > MAX_AMOUNT:
        return raw, "Amount is too large"
    return format(amount, "f"), None


def parse_reference(v: Any) -> tuple[str | None, str | None]:
    s = _text(v)
    if not s:
        return None, None
    if len(s) > 60:
        return s, "Reference must be 60 characters or fewer"
    return s, None


def parse_due_date(v: Any) -> tuple[str | None, str | None]:
    """Blank allowed. Day-first formats; real Excel dates and Excel serial numbers also work."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, None
    d: date | None = None
    if isinstance(v, datetime):
        d = v.date()
    elif isinstance(v, date):
        d = v
    elif isinstance(v, int | float) and not isinstance(v, bool) and 20000 <= v <= 80000:
        d = _EXCEL_EPOCH + timedelta(days=int(v))
    else:
        s = _text(v)
        for fmt in _DATE_FORMATS:
            try:
                d = datetime.strptime(s, fmt).date()
                break
            except ValueError:
                continue
    if d is None or not 2000 <= d.year <= 2100:
        return _text(v), "Enter a valid date, like 15/10/2026"
    return d.isoformat(), None


@dataclass
class RowResult:
    customer_name: str
    phone: str | None
    amount_due: str
    reference: str | None
    due_date: str | None
    errors: list[tuple[str, str]] = field(default_factory=list)


def validate_row(raw: dict[str, Any]) -> RowResult:
    name, e1 = parse_name(raw.get("customer_name"))
    phone, e2 = parse_phone(raw.get("phone"))
    amount, e3 = parse_amount(raw.get("amount_due"))
    ref, e4 = parse_reference(raw.get("reference"))
    due, e5 = parse_due_date(raw.get("due_date"))
    errors = [
        (f, m)
        for f, m in (
            ("customer_name", e1),
            ("phone", e2),
            ("amount_due", e3),
            ("reference", e4),
            ("due_date", e5),
        )
        if m
    ]
    return RowResult(name, phone, amount, ref, due, errors)
