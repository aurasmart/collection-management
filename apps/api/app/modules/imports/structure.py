"""Find the TABLES inside a worksheet before any column is interpreted.

Real exports (accounting reports, statements) put a company name, address, report title and date
range above the table, merge cells for grouped headings, repeat headings between pages and put
totals at the bottom. So the order here is: locate the block of record rows, then the heading band
directly above it, and only then (in detect.py) work out what each column means.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from app.modules.collections.rules import parse_amount, parse_due_date
from app.modules.imports.model import MAX_COLUMNS, Sheet
from app.modules.imports.readers import cell_text

MAX_BAND_ROWS = 8
MAX_GAP_ROWS = 3  # rows between two pieces of one table (page breaks, "carried forward" lines)
TITLE_SCAN_ROWS = 6
HEADER_SCAN_ROWS = 50

_DATE_RANGE = re.compile(r"\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{2,4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}")


@dataclass
class Table:
    header_rows: list[int]  # 0-based heading band (can be empty: the sheet has no headings)
    data_rows: list[int]  # 0-based rows that hold records (totals are removed later)
    key_col: int
    leaf: list[str]  # the heading of each column (lowest heading row that has text)
    context: list[str]  # the group heading above it, e.g. "Closing Balance"
    title: str
    skipped: list[tuple[int, str]] = field(default_factory=list)

    @property
    def first_row(self) -> int:
        return self.data_rows[0] if self.data_rows else (self.header_rows[-1] + 1)

    @property
    def last_row(self) -> int:
        return self.data_rows[-1] if self.data_rows else self.first_row


def _is_value(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int | float | datetime | date):
        return True
    if isinstance(v, str) and v.strip():
        s = v.strip()
        if parse_amount(s)[1] is None:
            return True
        return bool(_DATE_RANGE.fullmatch(s)) and parse_due_date(s)[1] is None
    return False


def _is_label(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    s = v.strip()
    letters = sum(ch.isalpha() for ch in s)
    return letters >= 2 and letters / len(s) >= 0.5 and not _is_value(s)


def _nonempty(row: list[Any]) -> list[int]:
    return [i for i, c in enumerate(row) if cell_text(c)]


def _is_record(row: list[Any]) -> bool:
    """A name next to at least one number, amount, date or phone."""
    labels = [i for i, c in enumerate(row) if _is_label(c)]
    values = [i for i, c in enumerate(row) if _is_value(c)]
    return any(v != lab for lab in labels for v in values)


def _runs(rows: list[list[Any]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start: int | None = None
    for i, row in enumerate(rows):
        if _is_record(row):
            start = i if start is None else start
        elif start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(rows) - 1))
    return out


def _expand_merges(
    rows: list[list[Any]], merges: list[tuple[int, int, int, int]], band: list[int]
) -> dict[int, list[Any]]:
    """Heading rows with merged cells spread across the columns they cover."""
    grid = {r: list(rows[r]) for r in band}
    width = max((len(r) for r in rows), default=0)
    for r in grid:
        grid[r] += [None] * (width - len(grid[r]))
    for r1, c1, r2, c2 in merges:
        if r1 >= len(rows) or c1 >= len(rows[r1]) or not cell_text(rows[r1][c1]):
            continue
        for r in band:
            if r1 <= r <= r2:
                for c in range(c1, min(c2, width - 1) + 1):
                    if not cell_text(grid[r][c]):
                        grid[r][c] = rows[r1][c1]
    return grid


def _headings(
    rows: list[list[Any]], merges: list[tuple[int, int, int, int]], band: list[int], width: int
) -> tuple[list[str], list[str]]:
    grid = _expand_merges(rows, merges, band)
    leaf, context = [""] * width, [""] * width
    for c in range(width):
        lowest: int | None = None
        for r in reversed(band):
            if c < len(grid[r]) and cell_text(grid[r][c]):
                lowest = r
                leaf[c] = cell_text(grid[r][c])
                break
        if lowest is None:
            continue
        for r in reversed([b for b in band if b < lowest]):
            t = cell_text(grid[r][c]) if c < len(grid[r]) else ""
            if t and len(t) <= 40 and not _DATE_RANGE.search(t) and t.lower() != leaf[c].lower():
                context[c] = t
                break
    return leaf, context


def _title(rows: list[list[Any]], top: int, floor: int = 0) -> str:
    seen: list[str] = []
    for r in range(top - 1, max(floor - 1, top - 1 - TITLE_SCAN_ROWS), -1):
        for c in _nonempty(rows[r]):
            t = cell_text(rows[r][c])
            if t and not _DATE_RANGE.search(t) and t not in seen and len(t) <= 80:
                seen.append(t)
                break
        if len(seen) == 2:
            break
    return " · ".join(seen)


def _key_col(rows: list[list[Any]], span: range) -> int:
    counts: dict[int, int] = {}
    for r in span:
        for c, v in enumerate(rows[r]):
            if _is_label(v):
                counts[c] = counts.get(c, 0) + 1
    return min(counts, key=lambda c: (-counts[c], c)) if counts else 0


def find_tables(sheet: Sheet) -> list[Table]:
    """Every block of records on the sheet, each with the heading band that belongs to it."""
    rows = sheet.rows
    width = min(max((len(r) for r in rows), default=0), MAX_COLUMNS)
    runs = _runs(rows)
    tables: list[tuple[Table, int, int]] = []  # (table, run_start, run_end)
    prev_end = -1
    for start, end in runs:
        key = _key_col(rows, range(start, end + 1))
        band: list[int] = []
        j = start - 1
        while j > prev_end and len(band) < MAX_BAND_ROWS:
            if [c for c in _nonempty(rows[j]) if c != key]:
                band.append(j)
                j -= 1
            else:
                break
        band.reverse()
        leaf, context = (
            _headings(rows, sheet.merges, band, width) if band else ([""] * width, [""] * width)
        )
        title = _title(rows, band[0] if band else start, prev_end + 1)
        tables.append(
            (Table(band, list(range(start, end + 1)), key, leaf, context, title), start, end)
        )
        prev_end = end
    return _join_pieces(rows, tables)


def _norm(leaf: list[str]) -> tuple[str, ...]:
    return tuple(c.lower() for c in leaf)


def _join_pieces(rows: list[list[Any]], parts: list[tuple[Table, int, int]]) -> list[Table]:
    """One table that continues after a page break or a stray line stays ONE table."""
    merged: list[Table] = []
    for table, start, _end in parts:
        prev = merged[-1] if merged else None
        gap = start - (prev.data_rows[-1] + 1) if prev else 0
        same_headings = (
            prev is not None and table.header_rows and _norm(table.leaf) == _norm(prev.leaf)
        )
        continues = prev is not None and (
            same_headings or (not table.header_rows and gap <= MAX_GAP_ROWS)
        )
        if prev is not None and continues:
            for r in table.header_rows:
                prev.skipped.append((r, "Repeated heading"))
            span = range(prev.data_rows[-1] + 1, table.data_rows[-1] + 1)
            for r in span:
                if r in table.header_rows or not _nonempty(rows[r]):
                    continue
                if r not in table.data_rows:
                    prev.skipped.append((r, "Not a customer row"))
                else:
                    prev.data_rows.append(r)
            continue
        merged.append(table)
    return merged


def manual_table(sheet: Sheet, header_row: int | None) -> Table:
    """The employer said where the headings are: everything below is records."""
    rows = sheet.rows
    width = min(max((len(r) for r in rows), default=0), MAX_COLUMNS)
    band = [header_row] if header_row is not None and header_row < len(rows) else []
    first = band[0] + 1 if band else 0
    data = [r for r in range(first, len(rows)) if _nonempty(rows[r])]
    leaf, context = (
        _headings(rows, sheet.merges, band, width) if band else ([""] * width, [""] * width)
    )
    key = _key_col(rows, range(first, len(rows))) if data else 0
    return Table(band, data, key, leaf, context, _title(rows, band[0] if band else first))


def fallback_table(sheet: Sheet, looks_like_heading: Callable[[str], bool]) -> Table | None:
    """Text-only sheets (no numbers to anchor on): a heading row of known terms."""
    rows = sheet.rows[:HEADER_SCAN_ROWS]
    best_i, best_hits = None, 0
    for i, row in enumerate(rows):
        hits = sum(1 for c in row if cell_text(c) and looks_like_heading(cell_text(c)))
        if hits > best_hits:
            best_i, best_hits = i, hits
    filled = len([c for c in rows[best_i] if cell_text(c)]) if best_i is not None else 0
    if best_i is not None and (best_hits >= 2 or filled >= 2) and best_i + 1 < len(sheet.rows):
        return manual_table(sheet, best_i)
    for i, row in enumerate(rows):
        texts = [cell_text(c) for c in row if cell_text(c)]
        plain = len(texts) >= 2 and all(not re.search(r"\d{3,}", t) for t in texts)
        if plain and i + 1 < len(sheet.rows) and len(_nonempty(sheet.rows[i + 1])) >= 2:
            return manual_table(sheet, i)
    return None
