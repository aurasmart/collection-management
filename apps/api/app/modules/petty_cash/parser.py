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


_TXN_BARE = re.compile(r"\b\d{12}\b|\b[A-Za-z]{1,3}\d{12,30}\b")


def _transaction_id(text: str) -> str | None:
    for m in _TXN.finditer(text):
        token = m.group(1)
        if any(ch.isdigit() for ch in token):
            return token
    # Labels and values on separate rows (two-column layouts): a 12-digit UPI reference, or the
    # letter-prefixed long numbers some apps print.
    bare = _TXN_BARE.search(text)
    return bare.group(0) if bare else None


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
# A number alone on its line, e.g. the big figure at the top of a UPI app. OCR often reads the rupee
# sign as a digit "2" (or another symbol) glued to the front, so that prefix is dropped.
_AMOUNT_BARE = re.compile(r"^\W*([^\d\s]{0,2})(\d[\d,]*\.\d{2})\W*$", re.M)
_AMOUNT_ANY = re.compile(r"(?<![\w.,/-])(\d{1,3}(?:,\d{2,3})*\.\d{2})(?![\w/-])")


def _to_amount(raw: str) -> str | None:
    try:
        value = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    if value <= 0 or value >= Decimal("100000000000"):
        return None
    return format(value.quantize(Decimal("0.01")), "f")


def _bare_amount(text: str) -> str | None:
    for m in _AMOUNT_BARE.finditer(text):
        digits = m.group(2)
        whole = digits.split(".")[0].replace(",", "")
        if not m.group(1) and digits.startswith("2") and len(whole) >= 4:
            digits = digits[1:]  # "21250.00" is "₹1250.00" with the sign misread as a 2
        if (a := _to_amount(digits)) is not None:
            return a
    return None


def _amount(text: str) -> str | None:
    for pattern in (_AMOUNT_SYMBOL, _AMOUNT_LABEL):
        for m in pattern.finditer(text):
            if (a := _to_amount(m.group(1))) is not None:
                return a
    if (a := _bare_amount(text)) is not None:
        return a
    for m in _AMOUNT_ANY.finditer(text):
        if (a := _to_amount(m.group(1))) is not None:
            return a
    return None


# --- labelled text fields --------------------------------------------------------------------
_NOISE = r"^\W*(?:\w{1,2}\s+)?"  # OCR often turns an icon at the start of a line into junk
_TO_LABELS = (
    r"(?:payment\s+to|paid\s+to|paying\s+to|sent\s+to|transferred\s+to|credited\s+to|"
    r"beneficiary(?:\s+name)?|receiver|payee)",
    r"(?:payment\s+)?received\s+by",
    r"banking\s+name",
    r"to",
)
_FROM_LABELS = (
    r"(?:payment\s+from|paid\s+from|paid\s+by|debited\s+from|sent\s+from|from\s+account|"
    r"sender|payer)",
    r"payment\s+(?:initiated\s+by|transferred\s+from)",
    r"debited\s+account",
    r"from",
)
_REMARKS = r"(?:remarks?|note|message|narration|description|purpose|comments?)"
_OTHER_LABELS = (
    r"(?:amount|payment\s+(?:mode|id|initiated|transferred|received)|mode|date|time|status|"
    r"reference|ref|transaction|txn|utr|upi|bank|banking|debited|ifsc|charges|fee|total|"
    r"process\s+details|hide\s+details|back\s+to|another\s+payment)"
)
_ANY_LABEL = "|".join([*_TO_LABELS, *_FROM_LABELS, _REMARKS, _OTHER_LABELS])
_LABEL_LINE = re.compile(rf"{_NOISE}(?:{_ANY_LABEL})\b", re.I)


def _tidy(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t:-–|·•")
    value = re.sub(r"['’]s account$", "", value, flags=re.I)
    return value.strip()


def _labelled(lines: list[str], labels: tuple[str, ...], *, continuation: int) -> str | None:
    """The value after the first label found; labels are tried in priority order."""
    for label in labels:
        head = re.compile(rf"{_NOISE}{label}\b\s*[:\-–]?\s*(.*)$", re.I)
        for i, line in enumerate(lines):
            m = head.match(line)
            if not m:
                continue
            parts = [m.group(1)] if m.group(1).strip() else []
            j = i + 1
            while j < len(lines) and len(parts) < continuation + 1:
                nxt = lines[j]
                if nxt.strip():
                    if _LABEL_LINE.match(nxt):
                        break
                    parts.append(re.sub(r"^\W+", "", nxt))  # drop leading junk from icons
                j += 1
            value = _tidy(" ".join(parts))
            if value:
                return value[:300]
    return None


def parse_receipt(text: str) -> ParsedReceipt:
    lines = [ln.rstrip() for ln in text.replace("\r", "\n").split("\n")]
    flat = "\n".join(lines)
    remarks = _labelled(lines, (_REMARKS,), continuation=0)
    if remarks and re.fullmatch(r"no\s+remarks?", remarks, re.I):
        remarks = None
    return ParsedReceipt(
        transaction_id=_transaction_id(flat),
        txn_date=_txn_date(flat),
        payment_to=_labelled(lines, _TO_LABELS, continuation=2),
        payment_from=_labelled(lines, _FROM_LABELS, continuation=2),
        remarks=remarks[:500] if remarks else None,
        amount=_amount(flat),
    )
