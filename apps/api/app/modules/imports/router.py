"""Import: SOURCE -> PARSE -> DETECT -> MAP -> REVIEW -> SERVER VALIDATION -> IMPORT.

Stateless: the browser keeps the file (or the Google Sheet link) and sends it again with each
step. Nothing is stored until /confirm, which re-validates every row and saves all or nothing.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from sqlalchemy import text

from app.core.db import tenant_session
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.collections.rules import DateOrder, RowResult, validate_row
from app.modules.imports import detect
from app.modules.imports.gsheets import GoogleSheetsClient, get_google_client, parse_sheet_url
from app.modules.imports.model import (
    FIELDS,
    LABELS,
    MAX_FILE_BYTES,
    MAX_ROWS,
    REQUIRED,
    ImportFileError,
    Workbook,
)
from app.modules.imports.ocr import OcrProvider, get_ocr_provider
from app.modules.imports.sources import read_upload

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])
Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
User = Annotated[AuthenticatedUser, Depends(require_user)]
Ocr = Annotated[OcrProvider | None, Depends(get_ocr_provider)]
Google = Annotated[GoogleSheetsClient, Depends(get_google_client)]


# ---------------------------------------------------------------- schemas
class FieldError(BaseModel):
    field: str
    message: str


class RowOut(BaseModel):
    row_number: int
    customer_name: str
    phone: str | None
    amount_due: str
    reference: str | None
    due_date: str | None
    errors: list[FieldError]
    warnings: list[FieldError] = []


class RowIn(BaseModel):
    """A row after the employer reviewed/edited it. The server re-validates everything."""

    model_config = ConfigDict(extra="forbid")
    row_number: int = Field(default=0, ge=0, le=1_000_000)
    customer_name: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=50)
    amount_due: str | None = Field(default=None, max_length=50)
    reference: str | None = Field(default=None, max_length=300)
    due_date: str | None = Field(default=None, max_length=50)


class SkippedOut(BaseModel):
    row_number: int
    reason: str


class PreviewOut(BaseModel):
    filename: str
    source: str
    ocr: bool
    rows: list[RowOut]
    skipped: list[SkippedOut]
    notes: list[str]
    total: int
    valid: int
    invalid: int


class RowsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: list[RowIn] = Field(max_length=MAX_ROWS)


class ConfirmIn(RowsIn):
    filename: str = Field(default="", max_length=255)
    source: Literal["excel", "csv", "pdf", "google_sheets"] | None = None
    rows: list[RowIn] = Field(min_length=1, max_length=MAX_ROWS)


class ConfirmOut(BaseModel):
    imported: int


class DateInfoOut(BaseModel):
    ambiguous: bool
    order: Literal["dmy", "mdy"]
    examples: list[str]


class ColumnOut(BaseModel):
    index: int
    header: str
    samples: list[str]
    suggested: Literal["customer_name", "phone", "amount_due", "reference", "due_date"] | None
    confidence: Literal["high", "uncertain", "none"]
    alternatives: list[str]
    date_info: DateInfoOut | None
    count: int
    total: str | None


class FieldStatusOut(BaseModel):
    field: Literal["customer_name", "phone", "amount_due", "reference", "due_date"]
    label: str
    required: bool
    status: Literal["detected", "uncertain", "missing"]
    column: int | None
    competing: list[int]


class SheetOut(BaseModel):
    index: int
    name: str
    rows: int


class TableOut(BaseModel):
    index: int
    title: str
    header_rows: list[int]  # 1-based first/last heading row, empty when there are no headings
    first_row: int  # 1-based first/last record row
    last_row: int
    records: int


class AnalysisOut(BaseModel):
    filename: str
    source: str
    ocr: bool
    sheets: list[SheetOut]
    sheet: int
    header_row: int  # 1-based row of the lowest heading line; 0 = no heading row
    table: int | None  # which detected table is shown (None = no table could be identified)
    tables: list[TableOut]
    structure: Literal["high", "low"]
    columns: list[ColumnOut]
    fields: list[FieldStatusOut]
    data_rows: int
    notes: list[str]


class GoogleConfigOut(BaseModel):
    private_access: bool
    service_account_email: str | None


# ---------------------------------------------------------------- helpers
_MappingAdapter = TypeAdapter(dict[str, int | None])


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=message)


def _load(
    file: UploadFile | None,
    sheet_url: str | None,
    ocr: OcrProvider | None,
    google: GoogleSheetsClient,
) -> tuple[Workbook, str]:
    """Any source -> grids. Returns the workbook and a display name."""
    if (file is None) == (not sheet_url):
        raise _unprocessable("Choose a file or paste a Google Sheets link.")
    try:
        if file is not None:
            data = file.file.read(MAX_FILE_BYTES + 1)
            return read_upload(file.filename or "", data, ocr), file.filename or ""
        ref = parse_sheet_url(sheet_url or "")
        return google.load(ref), "Google Sheet"
    except ImportFileError as exc:
        raise _unprocessable(str(exc)) from None


def _pick_sheet(wb: Workbook, sheet: int | None) -> int:
    if sheet is None:
        return detect.best_sheet(wb.sheets)
    if not 0 <= sheet < len(wb.sheets):
        raise _unprocessable("That worksheet doesn't exist.")
    return sheet


def _parse_mapping(raw: str | None, width: int) -> dict[str, int | None] | None:
    if not raw:
        return None
    try:
        mapping = _MappingAdapter.validate_json(raw)
    except ValidationError:
        raise _unprocessable("The column choices couldn't be read.") from None
    if set(mapping) - set(FIELDS):
        raise _unprocessable("The column choices couldn't be read.")
    cols = [c for c in mapping.values() if c is not None]
    if any(c < 0 or c >= width for c in cols) or len(cols) != len(set(cols)):
        raise _unprocessable("Each column can only be used once.")
    return mapping


def _row_out(row_number: int, r: RowResult, warnings: list[FieldError]) -> RowOut:
    return RowOut(
        row_number=row_number,
        customer_name=r.customer_name,
        phone=r.phone,
        amount_due=r.amount_due,
        reference=r.reference,
        due_date=r.due_date,
        errors=[FieldError(field=f, message=m) for f, m in r.errors],
        warnings=warnings,
    )


def _validated(rows: list[dict[str, Any]], order: DateOrder = "dmy") -> list[RowOut]:
    results = [
        (int(raw.get("row_number") or i + 1), validate_row(raw, order))
        for i, raw in enumerate(rows)
    ]
    first_seen: dict[tuple[str, str, str, str], int] = {}
    out: list[RowOut] = []
    for number, r in results:
        warnings: list[FieldError] = []
        if not r.errors:
            key = (
                r.customer_name.casefold(),
                r.amount_due,
                (r.reference or "").casefold(),
                r.phone or "",
            )
            if key in first_seen:
                warnings.append(
                    FieldError(
                        field="row", message=f"Looks like a duplicate of row {first_seen[key]}"
                    )
                )
            else:
                first_seen[key] = number
        out.append(_row_out(number, r, warnings))
    return out


def _mapping_notes(rows: list[RowOut]) -> list[str]:
    notes: list[str] = []
    n = len(rows)
    if n < 4:
        return notes
    for fld, label in (
        ("amount_due", "amounts"),
        ("phone", "phone numbers"),
        ("due_date", "dates"),
    ):
        bad = sum(1 for r in rows if any(e.field == fld for e in r.errors))
        if bad / n > 0.5:
            notes.append(
                f"Most {label} couldn't be read. This column may be mapped to the wrong field: "
                "go back and check the mapping."
            )
    return notes


def _analysis_out(
    wb: Workbook,
    filename: str,
    sheet_index: int,
    header_row: int | None | Literal["auto"],
    table: int | None,
) -> AnalysisOut:
    sheet = wb.sheets[sheet_index]
    a = detect.analyze_sheet(sheet, header_row, table)
    return AnalysisOut(
        filename=filename,
        source=wb.kind,
        ocr=wb.ocr,
        sheets=[SheetOut(index=i, name=s.name, rows=len(s.rows)) for i, s in enumerate(wb.sheets)],
        sheet=sheet_index,
        header_row=(a.header_row + 1) if a.header_row is not None else 0,
        table=a.table_index,
        tables=[
            TableOut(
                index=t.index,
                title=t.title,
                header_rows=[t.header_rows[0] + 1, t.header_rows[-1] + 1] if t.header_rows else [],
                first_row=t.first_row + 1,
                last_row=t.last_row + 1,
                records=t.records,
            )
            for t in a.tables
        ],
        structure=a.structure,
        columns=[
            ColumnOut(
                index=c.index,
                header=c.header,
                samples=c.samples,
                suggested=c.suggested,
                confidence=c.confidence,
                alternatives=[str(f) for f in c.alternatives],
                count=c.count,
                total=c.total,
                date_info=(
                    DateInfoOut(
                        ambiguous=c.date_info.ambiguous,
                        order=c.date_info.order,
                        examples=c.date_info.examples,
                    )
                    if c.date_info
                    else None
                ),
            )
            for c in a.columns
        ],
        fields=[
            FieldStatusOut(
                field=f.name,
                label=LABELS[f.name],
                required=f.name in REQUIRED,
                status=f.status,
                column=f.column,
                competing=f.competing,
            )
            for f in a.fields
        ],
        data_rows=a.data_rows,
        notes=[*wb.notes, *a.notes],
    )


def _header_param(header_row: int | None) -> int | None | Literal["auto"]:
    if header_row is None:
        return "auto"
    if header_row < 0 or header_row > 100:
        raise _unprocessable("That header row isn't valid.")
    return header_row - 1 if header_row > 0 else None


# ---------------------------------------------------------------- endpoints
@router.get(
    "/google-sheets",
    operation_id="getGoogleSheetsConfig",
    summary="Whether private Google Sheets can be imported, and who to share them with",
)
def google_sheets_config(_ctx: Ctx, google: Google) -> GoogleConfigOut:
    return GoogleConfigOut(
        private_access=google.private_access, service_account_email=google.service_account_email
    )


@router.post(
    "/analyze",
    operation_id="analyzeImport",
    summary="Read a file or Google Sheet and suggest what each column means",
)
def analyze_import(
    _ctx: Ctx,
    ocr: Ocr,
    google: Google,
    file: Annotated[UploadFile | None, File()] = None,
    sheet_url: Annotated[str | None, Form(max_length=2000)] = None,
    sheet: Annotated[int | None, Form()] = None,
    header_row: Annotated[int | None, Form()] = None,
    table: Annotated[int | None, Form()] = None,
) -> AnalysisOut:
    wb, name = _load(file, sheet_url, ocr, google)
    idx = _pick_sheet(wb, sheet)
    return _analysis_out(wb, name, idx, _header_param(header_row), table)


@router.post(
    "/preview",
    operation_id="previewImport",
    summary="Apply the confirmed column mapping and show the normalised rows",
)
def preview_import(
    _ctx: Ctx,
    ocr: Ocr,
    google: Google,
    file: Annotated[UploadFile | None, File()] = None,
    sheet_url: Annotated[str | None, Form(max_length=2000)] = None,
    sheet: Annotated[int | None, Form()] = None,
    header_row: Annotated[int | None, Form()] = None,
    table: Annotated[int | None, Form()] = None,
    mapping: Annotated[str | None, Form(max_length=2000)] = None,
    date_order: Annotated[Literal["dmy", "mdy"], Form()] = "dmy",
) -> PreviewOut:
    wb, name = _load(file, sheet_url, ocr, google)
    idx = _pick_sheet(wb, sheet)
    sh = wb.sheets[idx]
    analysis = detect.analyze_sheet(sh, _header_param(header_row), table)
    if analysis.table is None:
        raise _unprocessable(detect.NO_TABLE)
    chosen = _parse_mapping(mapping, max((len(r) for r in sh.rows), default=0))
    if chosen is None:
        chosen = {str(k): v for k, v in analysis.mapping.items()}
    final = {f: chosen.get(f) for f in FIELDS}
    missing = [LABELS[f] for f in REQUIRED if final.get(f) is None]
    if missing:
        raise _unprocessable(f"Choose a column for: {', '.join(missing)}.")
    try:
        built = detect.build_rows(sh, analysis, final)
    except ImportFileError as exc:
        raise _unprocessable(str(exc)) from None
    if not built.rows:
        raise _unprocessable("We found the columns but no customer rows below them.")
    rows = _validated(built.rows, date_order)
    invalid = sum(1 for r in rows if r.errors)
    return PreviewOut(
        filename=name,
        source=wb.kind,
        ocr=wb.ocr,
        rows=rows,
        skipped=[SkippedOut(row_number=s.row_number, reason=s.reason) for s in built.skipped],
        notes=[*wb.notes, *_mapping_notes(rows)],
        total=len(rows),
        valid=len(rows) - invalid,
        invalid=invalid,
    )


@router.post(
    "/validate",
    operation_id="validateImportRows",
    summary="Re-check rows after the employer edits them",
)
def validate_rows(body: RowsIn, _ctx: Ctx) -> list[RowOut]:
    return _validated([r.model_dump() for r in body.rows])


@router.post(
    "/confirm",
    operation_id="confirmImport",
    summary="Save the reviewed rows as customers (all or nothing)",
    responses={422: {"description": "Some rows still have errors"}},
)
def confirm_import(body: ConfirmIn, user: User, ctx: Ctx) -> ConfirmOut:
    checked = _validated([r.model_dump() for r in body.rows])
    if any(r.errors for r in checked):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Some rows still need fixing before they can be imported.",
        )
    customers = [
        {"id": uuid.uuid4(), "e": ctx.employer_id, "name": r.customer_name, "phone": r.phone}
        for r in checked
    ]
    collections = [
        {
            "id": uuid.uuid4(),
            "e": ctx.employer_id,
            "c": cust["id"],
            "amount": r.amount_due,
            "due": r.due_date,
            "ref": r.reference,
        }
        for r, cust in zip(checked, customers, strict=True)
    ]
    source = body.source or (
        re.sub(r"[^a-z]", "", body.filename.rsplit(".", 1)[-1].lower())[:5] or "file"
    )
    with tenant_session(ctx.employer_id) as db:
        db.execute(
            text(
                "INSERT INTO customers (id, employer_id, name, phone) "
                "VALUES (:id, :e, :name, :phone)"
            ),
            customers,
        )
        db.execute(
            text(
                "INSERT INTO collections "
                "(id, employer_id, customer_id, amount_due, due_date, reference) "
                "VALUES (:id, :e, :c, :amount, CAST(:due AS date), :ref)"
            ),
            collections,
        )
        db.execute(
            text(
                "INSERT INTO audit_events (employer_id, actor, entity_type, action, details) "
                "VALUES (:e, :actor, 'import', 'import_confirmed', CAST(:d AS jsonb))"
            ),
            {
                "e": ctx.employer_id,
                "actor": user.email or str(user.auth_user_id),
                "d": json.dumps({"customers": len(checked), "file_type": source}),
            },
        )
    return ConfirmOut(imported=len(checked))
