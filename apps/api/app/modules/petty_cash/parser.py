"""Pull the six petty-cash fields out of the text of a payment receipt (UPI, NEFT, IMPS, ...).

Pure functions, no I/O. Everything returned is a PROPOSAL: a field it cannot find is None and the
employer fills it in on the review form. Receipts differ per bank/app, so each field is found by its
label ("Payment to", "Reference ID", ...) with sensible fallbacks, never by position.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
    )
}
_MONTH_RE = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"


@dataclass(frozen=True)
class ParsedReceipt:
    transaction_id: str | None = None
    txn_date: date | None = None
    payment_to: str | None = None
    payment_from: str | None = None
    remarks: str | None = None
    amount: str | None = None  # plain decimal text, e.g. "162840.00"

    def found(self) -> list[str]:
        return [k for k, v in self.__dict__.items() if v not in (None, "")]


# --- transaction id --------------------------------------------------------------------------
_TXN = re.compile(
    r"\b(?:transaction|txn|upi|utr|reference|ref)\b"
    r"(?:[\s.\-]*(?:transaction|txn|reference|ref|id|no|number|num|utr)\b)*"
    r"[\s.:#\-]*([A-Za-z0-9]{8,35})\b",
    re.I,
)


def _transaction_id(text: str) -> str | None:
    for m in _TXN.finditer(text):
        token = m.group(1)
        if any(ch.isdigit() for ch in token):
            return token
    return None


# --- date ------------------------------------------------------------------------------------
_DATE_DMY_NAME = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?[\s\-/.,]*({_MONTH_RE})[\s,.'’`\"\-]*(\d{{2,4}})\b", re.I
)
_DATE_NAME_DMY = re.compile(
    rf"\b({_MONTH_RE})[\s.]*(\d{{1,2}})(?:st|nd|rd|th)?,?[\s'’`\"\-]*(\d{{4}})\b", re.I
)
_DATE_NUM = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b")
_DATE_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


def _year(y: str) -> int:
    n = int(y)
    return 2000 + n if len(y) == 2 else n


def _make_date(y: int, m: int, d: int) -> date | None:
    try:
        out = date(y, m, d)
    except ValueError:
        return None
    return out if 2000 <= out.year <= 2100 else None


def _txn_date(text: str) -> date | None:
    candidates: list[tuple[int, date]] = []
    for m in _DATE_ISO.finditer(text):
        if d := _make_date(int(m[1]), int(m[2]), int(m[3])):
            candidates.append((m.start(), d))
    for m in _DATE_DMY_NAME.finditer(text):
        if d := _make_date(_year(m[3]), _MONTHS[m[2][:3].lower()], int(m[1])):
            candidates.append((m.start(), d))
    for m in _DATE_NAME_DMY.finditer(text):
        if d := _make_date(int(m[3]), _MONTHS[m[1][:3].lower()], int(m[2])):
            candidates.append((m.start(), d))
    for m in _DATE_NUM.finditer(text):  # India writes day first
        if d := _make_date(_year(m[3]), int(m[2]), int(m[1])):
            candidates.append((m.start(), d))
    return min(candidates, key=lambda c: c[0])[1] if candidates else None


# --- amount ----------------------------------------------------------------------------------
_NUM = r"\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
_AMOUNT_SYMBOL = re.compile(rf"(?:₹|\bRs\.?|\bINR)\s*({_NUM})", re.I)
_AMOUNT_LABEL = re.compile(
    rf"\bamount\b(?:\s*(?:paid|debited|transferred|sent))?[^\d\n]{{0,25}}?({_NUM})", re.I
)
_AMOUNT_ANY = re.compile(r"(?<![\w.,/-])(\d{1,3}(?:,\d{2,3})*\.\d{2})(?![\w/-])")


def _to_amount(raw: str) -> str | None:
    try:
        value = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    if value <= 0 or value >= Decimal("100000000000"):
        return None
    return format(value.quantize(Decimal("0.01")), "f")


def _amount(text: str) -> str | None:
    for pattern in (_AMOUNT_SYMBOL, _AMOUNT_LABEL, _AMOUNT_ANY):
        for m in pattern.finditer(text):
            if (a := _to_amount(m.group(1))) is not None:
                return a
    return None


# --- labelled text fields --------------------------------------------------------------------
_TO = (
    r"(?:payment\s+to|paid\s+to|paying\s+to|sent\s+to|transferred\s+to|credited\s+to|"
    r"beneficiary(?:\s+name)?|receiver|payee|to)"
)
_FROM = (
    r"(?:payment\s+from|paid\s+from|paid\s+by|debited\s+from|sent\s+from|from\s+account|"
    r"sender|payer|from)"
)
_REMARKS = r"(?:remarks?|note|message|narration|description|purpose|comments?)"
_OTHER_LABELS = (
    r"(?:amount|payment\s+mode|mode|date|time|status|reference|ref|transaction|txn|utr|upi|"
    r"payment\s+id|bank|ifsc|charges|fee|total|back\s+to|another\s+payment)"
)
_LABEL_LINE = re.compile(rf"^\s*(?:{_TO}|{_FROM}|{_REMARKS}|{_OTHER_LABELS})\b", re.I)


def _tidy(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t:-–|·•")
    return value.strip()


def _labelled(lines: list[str], label: str, *, continuation: int) -> str | None:
    head = re.compile(rf"^\s*{label}\b\s*[:\-–]?\s*(.*)$", re.I)
    for i, line in enumerate(lines):
        m = head.match(line)
        if not m:
            continue
        parts = [m.group(1)] if m.group(1).strip() else []
        j = i + 1
        wanted = continuation + 1
        while j < len(lines) and len(parts) < wanted:
            nxt = lines[j]
            if nxt.strip():
                if _LABEL_LINE.match(nxt):
                    break
                parts.append(nxt)
            j += 1
        value = _tidy(" ".join(parts))
        if value:
            return value[:300]
    return None


def parse_receipt(text: str) -> ParsedReceipt:
    lines = [ln.rstrip() for ln in text.replace("\r", "\n").split("\n")]
    flat = "\n".join(lines)
    remarks = _labelled(lines, _REMARKS, continuation=0)
    return ParsedReceipt(
        transaction_id=_transaction_id(flat),
        txn_date=_txn_date(flat),
        payment_to=_labelled(lines, _TO, continuation=2),
        payment_from=_labelled(lines, _FROM, continuation=2),
        remarks=remarks[:500] if remarks else None,
        amount=_amount(flat),
    )
