from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app.core.db import tenant_session
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.collections.rules import RowResult, validate_row
from app.modules.imports.parser import MAX_FILE_BYTES, MAX_ROWS, ImportFileError, parse_upload

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])
Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
User = Annotated[AuthenticatedUser, Depends(require_user)]


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


class RowIn(BaseModel):
    """A row after the employer reviewed/edited it. The server re-validates everything."""

    model_config = ConfigDict(extra="forbid")
    row_number: int = Field(default=0, ge=0, le=1_000_000)
    customer_name: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=50)
    amount_due: str | None = Field(default=None, max_length=50)
    reference: str | None = Field(default=None, max_length=300)
    due_date: str | None = Field(default=None, max_length=50)


class PreviewOut(BaseModel):
    filename: str
    rows: list[RowOut]
    total: int
    valid: int
    invalid: int


class RowsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: list[RowIn] = Field(max_length=MAX_ROWS)


class ConfirmIn(RowsIn):
    filename: str = Field(default="", max_length=255)
    rows: list[RowIn] = Field(min_length=1, max_length=MAX_ROWS)


class ConfirmOut(BaseModel):
    imported: int


def _row_out(row_number: int, r: RowResult) -> RowOut:
    return RowOut(
        row_number=row_number,
        customer_name=r.customer_name,
        phone=r.phone,
        amount_due=r.amount_due,
        reference=r.reference,
        due_date=r.due_date,
        errors=[FieldError(field=f, message=m) for f, m in r.errors],
    )


def _validated(rows: list[dict[str, Any]]) -> list[RowOut]:
    return [
        _row_out(int(raw.get("row_number") or i + 1), validate_row(raw))
        for i, raw in enumerate(rows)
    ]


@router.post(
    "/preview", operation_id="previewImport", summary="Read an .xlsx/.csv file and show the rows"
)
def preview_import(file: UploadFile, _ctx: Ctx) -> PreviewOut:
    data = file.file.read(MAX_FILE_BYTES + 1)
    try:
        raw_rows = parse_upload(file.filename or "", data)
    except ImportFileError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from None
    rows = _validated(raw_rows)
    invalid = sum(1 for r in rows if r.errors)
    return PreviewOut(
        filename=file.filename or "",
        rows=rows,
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
                "d": json.dumps(
                    {
                        "customers": len(checked),
                        "file_type": (body.filename.rsplit(".", 1)[-1].lower()[:5]),
                    }
                ),
            },
        )
    return ConfirmOut(imported=len(checked))
