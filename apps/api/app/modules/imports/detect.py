"""Column detection and mapping.

Header evidence (aliases, normalised names, fuzzy matching) and content evidence (what the values
look like) are combined. Anything that is not clearly right is reported as UNCERTAIN so the
employer confirms it; nothing low-confidence is ever applied silently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
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
from app.modules.imports.structure import Table, fallback_table, find_tables, manual_table

SAMPLE_VALUES = 200
Confidence = Literal["high", "uncertain", "none"]

ALIASES: dict[Field, tuple[str, ...]] = {
    "customer_name": (
        "customer", "customer name", "party", "party name", "client", "client name", "account",
        "account name", "company", "company name", "name", "customer/party", "customer party",
        "buyer", "buyer name", "debtor", "debtor name", "ledger", "ledger name", "particulars",
        "party particulars", "name of party", "name of customer",
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


# ---------------------------------------------------------------- accounting vocabulary
# Debit/Credit columns are the two SIDES of a balance. Neither is "the amount due" by name: which
# side is money owed to the employer depends on the report, so the employer decides.
SIDE_TERMS = {
    "debit",
    "credit",
    "dr",
    "cr",
    "debit amount",
    "credit amount",
    "debit balance",
    "credit balance",
}
LEDGER_DUPLICATE_RATIO = 0.2


def looks_like_heading(text: str) -> bool:
    t = text.strip()
    return (
        bool(t)
        and not re.fullmatch(r"[\d.,]+", t)
        and (max(header_score(t, f) for f in FIELDS) >= 0.75 or t.lower() in SIDE_TERMS)
    )


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
    count: int = 0  # how many records have an amount in this column
    total: str | None = None  # their sum (for choosing between Debit and Credit)


@dataclass
class FieldStatus:
    name: Field
    status: Literal["detected", "uncertain", "missing"]
    column: int | None
    competing: list[int] = field(default_factory=list)


@dataclass
class TableSummary:
    index: int
    title: str
    header_rows: list[int]  # 0-based
    first_row: int
    last_row: int
    records: int


@dataclass
class SheetAnalysis:
    table: Table | None
    table_index: int | None
    tables: list[TableSummary]
    structure: Literal["high", "low"]
    columns: list[ColumnInfo]
    fields: list[FieldStatus]
    data_rows: int
    notes: list[str]
    amount_alternatives: list[int] = field(default_factory=list)

    @property
    def header_row(self) -> int | None:
        """0-based row of the lowest heading line, or None when the table has no headings."""
        return self.table.header_rows[-1] if self.table and self.table.header_rows else None

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


def _label(f: Field) -> str:
    from app.modules.imports.model import LABELS

    return LABELS[f]


def _is_total(label: str) -> bool:
    return bool(_TOTAL_RE.match(label))


_TOTAL_RE = re.compile(
    r"^(grand\s*total|sub\s*total|total|totals|net\s*total|summary|total\s+outstanding|"
    r"total\s+due|total\s+amount|closing\s+balance|opening\s+balance|balance\s+c/?f|carried\s+forward|"
    r"brought\s+forward|page\s+total)\b",
    re.I,
)


def _summaries(sheet: Sheet, tables: list[Table]) -> list[TableSummary]:
    out = []
    for i, t in enumerate(tables):
        records = sum(
            1
            for r in t.data_rows
            if not _is_total(
                cell_text(sheet.rows[r][t.key_col]) if t.key_col < len(sheet.rows[r]) else ""
            )
        )
        out.append(TableSummary(i, t.title, t.header_rows, t.first_row, t.last_row, records))
    return out


def _table_score(sheet: Sheet, t: Table) -> int:
    hits = sum(1 for h in t.leaf if h and looks_like_heading(h))
    return hits * 1000 + len(t.data_rows)


def candidate_tables(sheet: Sheet, header_row: int | None | Literal["auto"]) -> list[Table]:
    if header_row != "auto":
        return [manual_table(sheet, header_row)]
    tables = find_tables(sheet)
    if not tables:
        fb = fallback_table(sheet, looks_like_heading)
        tables = [fb] if fb else []
    big = [t for t in tables if len(t.data_rows) >= 2]  # a lone stray line is not a table
    return big or tables


NO_TABLE = "We couldn't confidently identify the table structure."


def analyze_sheet(
    sheet: Sheet,
    header_row: int | None | Literal["auto"] = "auto",
    table_index: int | None = None,
) -> SheetAnalysis:
    tables = candidate_tables(sheet, header_row)
    tables = [t for t in tables if t.data_rows]
    if not tables:
        fields = [FieldStatus(f, "missing", None) for f in FIELDS]
        return SheetAnalysis(None, None, [], "low", [], fields, 0, [NO_TABLE])
    chosen = (
        table_index
        if table_index is not None and 0 <= table_index < len(tables)
        else max(range(len(tables)), key=lambda i: _table_score(sheet, tables[i]))
    )
    table = tables[chosen]
    a = _analyze_table(sheet, table)
    a.table_index = chosen
    a.tables = _summaries(sheet, tables)
    if len(tables) > 1:
        a.notes.insert(
            0, f"We found {len(tables)} tables on this sheet. Choose the one with your customers."
        )
    return a


def _analyze_table(sheet: Sheet, table: Table) -> SheetAnalysis:
    rows = sheet.rows
    width = min(max((len(r) for r in rows), default=0), MAX_COLUMNS)
    has_headings = bool(table.header_rows)
    cols_values = [
        [(rows[r][i] if i < len(rows[r]) else None) for r in table.data_rows] for i in range(width)
    ]
    leaf = [table.leaf[i] if i < len(table.leaf) else "" for i in range(width)]
    context = [table.context[i] if i < len(table.context) else "" for i in range(width)]
    signals = [column_signals(v) for v in cols_values]

    keep = [i for i in range(width) if leaf[i] or signals[i].n]
    columns: list[ColumnInfo] = []
    for i in keep:
        samples: list[str] = []
        for v in cols_values[i]:
            t = cell_text(v)
            if t and t not in samples:
                samples.append(t[:40])
            if len(samples) == 3:
                break
        shown = (
            f"{context[i]} – {leaf[i]}" if context[i] and leaf[i] else leaf[i] or column_label(i)
        )
        columns.append(ColumnInfo(i, shown, samples, date_info=_date_info(cols_values[i])))
    by_index = {c.index: c for c in columns}
    records_idx = [
        r
        for r in table.data_rows
        if not _is_total(cell_text(rows[r][table.key_col]) if table.key_col < len(rows[r]) else "")
    ]
    for i in keep:
        amounts = [
            parse_amount(rows[r][i])[0]
            for r in records_idx
            if i < len(rows[r]) and cell_text(rows[r][i]) and parse_amount(rows[r][i])[1] is None
        ]
        if amounts:
            by_index[i].count = len(amounts)
            by_index[i].total = format(sum((Decimal(a) for a in amounts), Decimal(0)), "f")

    scores: dict[tuple[int, Field], float] = {}
    for i in keep:
        for f in FIELDS:
            s = candidate_score(leaf[i] if has_headings else "", signals[i], f)
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

    notes: list[str] = []
    sides = [i for i in keep if leaf[i].strip().lower() in SIDE_TERMS and signals[i].amount >= 0.7]
    dated = any(by_index[i].date_info for i in keep)
    key_values = [
        cell_text(rows[r][table.key_col]) for r in table.data_rows if table.key_col < len(rows[r])
    ]
    key_values = [v.lower() for v in key_values if v and not _is_total(v)]
    repeated = (
        bool(key_values) and 1 - len(set(key_values)) / len(key_values) >= LEDGER_DUPLICATE_RATIO
    )
    ledger = dated and repeated
    force_choose: list[int] = []
    amount_col = assigned_col.get("amount_due")
    if ledger:
        notes.append(
            "This appears to be a ledger/transaction report. We need to determine which column "
            "represents the customer's outstanding balance. Choose it below; we never add up "
            "transactions for you."
        )
        force_choose = [i for i in keep if signals[i].amount >= 0.7 and i not in (table.key_col,)]
    elif len(sides) >= 2 and (amount_col is None or amount_col in sides):
        names = " and ".join(f'"{by_index[i].header}"' for i in sides[:2])
        notes.append(
            f"This looks like an accounting summary with {names} columns. We can't tell which one "
            "holds the amount your customers owe you, so please choose. (In most accounting "
            "reports "
            "money owed to you is on the Debit side.) Parties whose balance is on the other side "
            "are skipped and listed."
        )
        force_choose = sides
    if force_choose:
        assigned_col.pop("amount_due", None)
        used = set(assigned_col.values())

    statuses: list[FieldStatus] = []
    for f in FIELDS:
        col = assigned_col.get(f)
        if f == "amount_due" and force_choose:
            statuses.append(FieldStatus(f, "uncertain", None, sorted(force_choose)))
            continue
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
        by_index[col].suggested = f
        by_index[col].confidence = "high" if confident else "uncertain"
    for (i, f), s in scores.items():
        if s >= 0.45 and i in by_index:
            by_index[i].alternatives.append(f)
    for st in statuses:
        if st.status == "uncertain" and st.competing and st.column is not None:
            names = ", ".join(f'"{by_index[c].header}"' for c in [st.column, *st.competing])
            notes.append(
                f"Several columns could be the {_label(st.name)}: {names}. Please choose one."
            )

    alternatives = sorted(
        set(force_choose) | {i for (i, f) in scores if f == "amount_due" and scores[(i, f)] >= 0.6}
    )
    records = sum(1 for v in key_values)
    named = any(st.status != "missing" for st in statuses if st.name in REQUIRED)
    structure: Literal["high", "low"] = "high" if has_headings or named else "low"
    if structure == "low":
        notes.append(NO_TABLE + " Check the rows below, or choose where the headings are.")
    return SheetAnalysis(
        table, None, [], structure, columns, statuses, records, notes, alternatives
    )


def best_sheet(sheets: list[Sheet]) -> int:
    best_i, best_score = 0, -1
    for i, sh in enumerate(sheets[:20]):
        score = analyze_sheet(sh).score
        if score > best_score:
            best_i, best_score = i, score
    return best_i


# ---------------------------------------------------------------- applying a mapping
@dataclass
class Skipped:
    row_number: int
    reason: str


@dataclass
class BuiltRows:
    rows: list[dict[str, Any]]
    skipped: list[Skipped]
    blank: int


def build_rows(
    sheet: Sheet, analysis: SheetAnalysis, mapping: dict[Field, int | None]
) -> BuiltRows:
    """Apply the confirmed mapping. Totals and repeated headings are not customers."""
    table = analysis.table
    if table is None:
        return BuiltRows([], [], 0)
    rows = sheet.rows
    heading = [_compact(h) for h in table.leaf]
    amount_col = mapping.get("amount_due")
    others = [c for c in analysis.amount_alternatives if c != amount_col]
    by_index = {c.index: c.header for c in analysis.columns}
    built: list[dict[str, Any]] = []
    skipped = [Skipped(r + 1, why) for r, why in table.skipped]
    for r in table.data_rows:
        row = rows[r]
        cells = [cell_text(c) for c in row]
        values: dict[str, Any] = {}
        for f, col in mapping.items():
            values[f] = row[col] if col is not None and col < len(row) else None
        if table.header_rows and sum(
            1 for a, b in zip(heading, (_compact(c) for c in cells), strict=False) if a and a == b
        ) >= max(2, sum(1 for a in heading if a) // 2):
            skipped.append(Skipped(r + 1, "Repeated heading"))
            continue
        label = cell_text(values.get("customer_name")) or next((c for c in cells if c), "")
        if _is_total(label):
            skipped.append(Skipped(r + 1, "Total or summary row"))
            continue
        if amount_col is not None and not cell_text(values.get("amount_due")):
            other = next((c for c in others if c < len(row) and cell_text(row[c])), None)
            if other is not None:
                skipped.append(
                    Skipped(
                        r + 1,
                        f'The balance is in "{by_index.get(other, "another column")}", '
                        f'not "{by_index.get(amount_col, "the chosen column")}"',
                    )
                )
                continue
        if not any(cell_text(v) for v in values.values()):
            skipped.append(Skipped(r + 1, "Row has none of the mapped columns"))
            continue
        values["row_number"] = r + 1
        built.append(values)
        if len(built) > MAX_ROWS:
            raise ImportFileError(
                f"This file has more than {MAX_ROWS} rows. Split it and upload in parts."
            )
    skipped.sort(key=lambda s: s.row_number)
    return BuiltRows(built, skipped, 0)
