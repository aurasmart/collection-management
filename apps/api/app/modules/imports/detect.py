"""Column detection and mapping.

Header evidence (aliases, normalised names, fuzzy matching) and content evidence (what the values
look like) are combined. Anything that is not clearly right is reported as UNCERTAIN so the
employer confirms it; nothing low-confidence is ever applied silently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from difflib import SequenceMatcher
from typing import Any, Literal

from app.modules.collections.rules import parse_amount, parse_due_date, parse_phone
from app.modules.imports.model import (
    FIELDS,
    MAX_COLUMNS,
    MAX_ROWS,
    REQUIRED,
    Field,
    ImportFileError,
    Sheet,
)
from app.modules.imports.readers import cell_text

HEADER_SCAN_ROWS = 10
SAMPLE_VALUES = 200
Confidence = Literal["high", "uncertain", "none"]

ALIASES: dict[Field, tuple[str, ...]] = {
    "customer_name": (
        "customer", "customer name", "party", "party name", "client", "client name", "account",
        "account name", "company", "company name", "name", "customer/party", "customer party",
        "buyer", "buyer name", "debtor", "debtor name", "ledger", "ledger name",
    ),
    "phone": (
        "phone", "phone number", "phone no", "phone no.", "mobile", "mobile number", "mobile no",
        "mobile no.", "contact", "contact number", "contact no", "contact no.", "telephone", "tel",
        "whatsapp", "whatsapp number", "cell", "cell number",
    ),
    "amount_due": (
        "amount", "amount due", "due amount", "outstanding", "outstanding amount", "balance",
        "balance due", "pending", "pending amount", "receivable", "receivable amount", "total due",
        "net amount", "amount receivable", "total outstanding", "closing balance", "due",
        "balance amount", "amount pending", "amount outstanding", "net outstanding",
    ),
    "reference": (
        "reference", "reference no", "reference number", "ref no", "ref number", "ref",
        "invoice", "invoice no", "invoice number", "bill no", "bill number", "bill", "order no",
        "order number", "order", "invoice #", "bill no.", "inv no", "inv no.", "voucher no",
    ),
    "due_date": (
        "due date", "payment due", "due", "deadline", "payment deadline", "due on",
        "payment date", "payment due date", "due by", "pay by", "last date",
    ),
}  # fmt: skip
# "due" alone is both an amount ("Due") and a date ("Due"): content decides, and a tie is shown.
_AMBIGUOUS_ALIASES = {"due"}


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


_ALIAS_COMPACT: dict[Field, list[tuple[str, list[str]]]] = {
    f: [(_compact(a), _tokens(a)) for a in names] for f, names in ALIASES.items()
}


def header_score(header: str, fld: Field) -> float:
    """0..1 evidence that this header means `fld`. 1.0 = an exact known name."""
    compact = _compact(header)
    if not compact:
        return 0.0
    head_tokens = set(_tokens(header))
    best = 0.0
    for alias_compact, alias_tokens in _ALIAS_COMPACT[fld]:
        if compact == alias_compact:
            if alias_compact in _AMBIGUOUS_ALIASES:
                best = max(best, 0.7)
            else:
                return 1.0
        if len(alias_compact) >= 5 and abs(len(compact) - len(alias_compact)) <= 3:
            ratio = SequenceMatcher(None, compact, alias_compact).ratio()
            if ratio >= 0.86:
                best = max(best, 0.9 * ratio)  # a typo such as "Ammount Due"
        if len(alias_tokens) >= 2 and set(alias_tokens) <= head_tokens:
            best = max(best, 0.85)  # "Customer Name (as per ledger)"
        elif len(alias_tokens) == 1 and alias_tokens[0] in head_tokens and len(head_tokens) <= 4:
            best = max(best, 0.6)  # "Amount (INR)": plausible, but needs a second opinion
    return best


# ---------------------------------------------------------------- content signals
_DATE_SLASH = re.compile(r"^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})\s*$")
_REF_RE = re.compile(r"^(?=.*\d)(?=.*[A-Za-z\-/#])[A-Za-z0-9][A-Za-z0-9\-/_.# ]{1,29}$")


@dataclass
class Signals:
    n: int = 0
    phone: float = 0.0
    amount: float = 0.0
    date: float = 0.0
    name: float = 0.0
    reference: float = 0.0
    numeric: float = 0.0


def _is_date_like(v: Any) -> bool:
    if isinstance(v, datetime | date):
        return True
    if isinstance(v, str):
        s = v.strip()
        plain = not re.search(r"[/\-. ]", s) or s.replace(".", "").replace("-", "").isdigit()
        if plain and not _DATE_SLASH.match(s):
            return False
        return parse_due_date(s, "dmy")[1] is None or parse_due_date(s, "mdy")[1] is None
    return False


def _is_phone_like(v: Any) -> bool:
    if isinstance(v, bool | datetime | date):
        return False
    if isinstance(v, float) and not v.is_integer():
        return False
    s = cell_text(v)
    if re.search(r"[A-Za-z]", s) or "," in s:
        return False
    digits = re.sub(r"\D", "", s)
    if len(digits) < 10:
        return False
    return parse_phone(s)[1] is None


def column_signals(values: list[Any]) -> Signals:
    vals = [v for v in values if cell_text(v)][:SAMPLE_VALUES]
    n = len(vals)
    if n == 0:
        return Signals()
    phone = date_ = amount = name = ref = numeric = 0
    for v in vals:
        text = cell_text(v)
        is_phone = _is_phone_like(v)
        is_date = _is_date_like(v)
        if is_phone:
            phone += 1
        if is_date:
            date_ += 1
        is_number = isinstance(v, int | float) and not isinstance(v, bool)
        if is_number or (isinstance(v, str) and re.search(r"\d", text)):
            numeric += 1
        if not is_phone and not is_date and parse_amount(v)[1] is None:
            amount += 1
        letters = sum(ch.isalpha() for ch in text)
        if (
            isinstance(v, str)
            and not is_phone
            and not is_date
            and letters >= 2
            and letters / max(len(text), 1) >= 0.6
            and len(text) <= 80
        ):
            name += 1
        if isinstance(v, str) and _REF_RE.match(text) and not is_phone and not is_date:
            ref += 1
    return Signals(n, phone / n, amount / n, date_ / n, name / n, ref / n, numeric / n)


_CONTENT_FIELD = {
    "phone": "phone",
    "amount_due": "amount",
    "due_date": "date",
    "customer_name": "name",
    "reference": "reference",
}


def content_ratio(sig: Signals, fld: Field) -> float:
    return float(getattr(sig, _CONTENT_FIELD[fld]))


def candidate_score(header: str, sig: Signals, fld: Field) -> float:
    """Combine header and content evidence into one 0..1 score for (column, field)."""
    h = header_score(header, fld)
    c = content_ratio(sig, fld) if sig.n else 0.5  # an empty column proves nothing either way
    if h >= 0.95:
        return 1.0 if c >= 0.5 else 0.7  # right name, odd contents: ask
    if h >= 0.75 or (h >= 0.7 and c >= 0.9):  # "Due" alone: the contents settle it
        return 0.82 if c >= 0.5 else 0.6
    if h > 0:
        return 0.6 if c >= 0.7 else 0.45
    if sig.n and c >= 0.9 and fld in ("phone", "due_date"):
        return 0.8  # a column of mobile numbers / dates is very distinctive
    if sig.n and c >= 0.7:
        return 0.6 * c + 0.05  # contents only: plausible, never silent
    return 0.0


# ---------------------------------------------------------------- header row + columns
def header_row_index(rows: list[list[Any]]) -> int | None:
    """0-based header row among the first rows, or None when the sheet has no header."""
    best_i, best_hits = None, 0
    for i, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        texts = [cell_text(c) for c in row]
        hits = sum(
            1
            for t in texts
            if t
            and not re.fullmatch(r"[\d.,]+", t)
            and max(header_score(t, f) for f in FIELDS) >= 0.75
        )
        if hits > best_hits:
            best_i, best_hits = i, hits
    if best_i is not None and best_hits >= 2:
        return best_i
    if best_i is not None and best_hits == 1:
        row = [cell_text(c) for c in rows[best_i]]
        if sum(1 for t in row if t) >= 2 and best_i + 1 < len(rows):
            return best_i
    # No known names: a row of short text cells followed by a row with numbers looks like a header.
    for i, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        texts = [cell_text(c) for c in row]
        filled = [t for t in texts if t]
        if (
            len(filled) >= 2
            and all(not re.search(r"\d{3,}", t) for t in filled)
            and i + 1 < len(rows)
        ):
            nxt = [cell_text(c) for c in rows[i + 1]]
            if sum(1 for t in nxt if t) >= 2:
                return i
    return None


def column_label(index: int) -> str:
    n, out = index, ""
    while True:
        out = chr(ord("A") + n % 26) + out
        n = n // 26 - 1
        if n < 0:
            return f"Column {out}"


@dataclass
class DateInfo:
    ambiguous: bool
    order: Literal["dmy", "mdy"]
    examples: list[str] = field(default_factory=list)


@dataclass
class ColumnInfo:
    index: int
    header: str
    samples: list[str]
    suggested: Field | None = None
    confidence: Confidence = "none"
    alternatives: list[Field] = field(default_factory=list)
    date_info: DateInfo | None = None


@dataclass
class FieldStatus:
    name: Field
    status: Literal["detected", "uncertain", "missing"]
    column: int | None
    competing: list[int] = field(default_factory=list)


@dataclass
class SheetAnalysis:
    header_row: int | None  # 0-based; None = no header row
    columns: list[ColumnInfo]
    fields: list[FieldStatus]
    data_rows: int
    notes: list[str]

    @property
    def mapping(self) -> dict[Field, int | None]:
        return {f.name: f.column for f in self.fields}

    @property
    def score(self) -> int:
        points = 0
        for f in self.fields:
            if f.status == "detected":
                points += 100 if f.name in REQUIRED else 10
            elif f.status == "uncertain":
                points += 40 if f.name in REQUIRED else 4
        return points * 10_000 + min(self.data_rows, 9_999)


def _date_info(values: list[Any]) -> DateInfo | None:
    vals = [v for v in values if cell_text(v)][:SAMPLE_VALUES]
    if not vals or sum(_is_date_like(v) for v in vals) / len(vals) < 0.5:
        return None
    day_first = month_first = 0
    ambiguous: list[str] = []
    for v in vals:
        if not isinstance(v, str):
            continue
        m = _DATE_SLASH.match(v)
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2))
        if a > 12:
            day_first += 1
        elif b > 12:
            month_first += 1
        elif a != b:
            ambiguous.append(v.strip())
    if month_first and not day_first:
        return DateInfo(False, "mdy")
    if day_first or month_first:
        return DateInfo(False, "dmy")  # explicit evidence (or mixed: the review flags the odd ones)
    return DateInfo(bool(ambiguous), "dmy", ambiguous[:3])


def analyze_sheet(sheet: Sheet, header_row: int | None | Literal["auto"] = "auto") -> SheetAnalysis:
    rows = sheet.rows
    h = header_row_index(rows) if header_row == "auto" else header_row
    first_data = (h + 1) if h is not None else 0
    width = min(max((len(r) for r in rows), default=0), MAX_COLUMNS)
    data = rows[first_data:]
    cols_values = [[(r[i] if i < len(r) else None) for r in data] for i in range(width)]
    headers = [
        (cell_text(rows[h][i]) if h is not None and i < len(rows[h]) else "") or column_label(i)
        for i in range(width)
    ]
    # Drop columns that are empty both in the header and in the data.
    columns: list[ColumnInfo] = []
    signals: list[Signals] = []
    for i in range(width):
        samples: list[str] = []
        for v in cols_values[i]:
            t = cell_text(v)
            if t and t not in samples:
                samples.append(t[:40])
            if len(samples) == 3:
                break
        columns.append(ColumnInfo(i, headers[i], samples, date_info=_date_info(cols_values[i])))
        signals.append(column_signals(cols_values[i]))

    scores: dict[tuple[int, Field], float] = {}
    for i in range(width):
        for f in FIELDS:
            s = candidate_score(headers[i] if h is not None else "", signals[i], f)
            if s >= 0.45:
                scores[(i, f)] = s
    order = {f: n for n, f in enumerate(FIELDS)}
    assigned_col: dict[Field, int] = {}
    used: set[int] = set()
    for (i, f), _ in sorted(scores.items(), key=lambda kv: (-kv[1], order[kv[0][1]], kv[0][0])):
        if f in assigned_col or i in used:
            continue
        assigned_col[f] = i
        used.add(i)

    statuses: list[FieldStatus] = []
    for f in FIELDS:
        col = assigned_col.get(f)
        if col is None:
            statuses.append(FieldStatus(f, "missing", None))
            continue
        best = scores[(col, f)]
        competing = [
            i
            for (i, g), sc in scores.items()
            if g == f and i != col and i not in used and sc >= 0.6 and sc >= best - 0.15
        ]
        confident = best >= 0.8 and not competing
        statuses.append(
            FieldStatus(f, "detected" if confident else "uncertain", col, sorted(competing))
        )
        columns[col].suggested = f
        columns[col].confidence = "high" if confident else "uncertain"
    for (i, f), s in scores.items():
        if s >= 0.45:
            columns[i].alternatives.append(f)

    notes: list[str] = []
    for st in statuses:
        if st.status == "uncertain" and st.competing:
            names = ", ".join(f'"{headers[c]}"' for c in [st.column or 0, *st.competing])
            notes.append(
                f"Several columns could be the {_label(st.name)}: {names}. Please choose one."
            )
    return SheetAnalysis(h, columns, statuses, len(data), notes)


def _label(f: Field) -> str:
    from app.modules.imports.model import LABELS

    return LABELS[f]


def best_sheet(sheets: list[Sheet]) -> int:
    best_i, best_score = 0, -1
    for i, sh in enumerate(sheets[:20]):
        score = analyze_sheet(sh).score
        if score > best_score:
            best_i, best_score = i, score
    return best_i


# ---------------------------------------------------------------- applying a mapping
_TOTAL_RE = re.compile(
    r"^(grand\s*total|sub\s*total|total|totals|net\s*total|summary|total\s+outstanding|"
    r"total\s+due|total\s+amount|closing\s+balance|balance\s+c/?f|carried\s+forward|"
    r"brought\s+forward|page\s+total)\b",
    re.I,
)


@dataclass
class Skipped:
    row_number: int
    reason: str


@dataclass
class BuiltRows:
    rows: list[dict[str, Any]]
    skipped: list[Skipped]
    blank: int


def build_rows(sheet: Sheet, header_row: int | None, mapping: dict[Field, int | None]) -> BuiltRows:
    """Apply the confirmed mapping. Totals, repeated headers and blank lines are not customers."""
    rows = sheet.rows
    start = (header_row + 1) if header_row is not None else 0
    header_cells = (
        [_compact(cell_text(c)) for c in rows[header_row]] if header_row is not None else []
    )
    built: list[dict[str, Any]] = []
    skipped: list[Skipped] = []
    blank = 0
    for offset, row in enumerate(rows[start:], start=start + 1):
        cells = [cell_text(c) for c in row]
        if not any(cells):
            blank += 1
            continue
        values: dict[str, Any] = {}
        for f, col in mapping.items():
            values[f] = row[col] if col is not None and col < len(row) else None
        if header_cells and sum(
            1
            for a, b in zip(header_cells, (_compact(c) for c in cells), strict=False)
            if a and a == b
        ) >= max(2, sum(1 for a in header_cells if a) // 2):
            skipped.append(Skipped(offset, "Repeated header row"))
            continue
        label = cell_text(values.get("customer_name")) or next((c for c in cells if c), "")
        if _TOTAL_RE.match(label):
            skipped.append(Skipped(offset, "Total or summary row"))
            continue
        if not any(cell_text(v) for v in values.values()):
            skipped.append(Skipped(offset, "Row has none of the mapped columns"))
            continue
        values["row_number"] = offset
        built.append(values)
        if len(built) > MAX_ROWS:
            raise ImportFileError(
                f"This file has more than {MAX_ROWS} rows. Split it and upload in parts."
            )
    return BuiltRows(built, skipped, blank)
