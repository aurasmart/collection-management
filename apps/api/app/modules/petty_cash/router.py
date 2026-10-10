"""Petty cash: a receipt (image/PDF) is read into PROPOSED fields, the employer reviews them, and
only then is an entry saved together with its receipt (ADR 0008)."""

# ruff: noqa: S608
# (the SQL here is built only from constant column lists and clauses; values are bound)
from __future__ import annotations

import json
import logging
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.db import tenant_session
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.imports.ocr import OcrError, OcrUnavailable
from app.modules.petty_cash import files
from app.modules.petty_cash.parser import parse_receipt
from app.modules.petty_cash.schemas import (
    PettyCashEntry,
    PettyCashFields,
    PettyCashList,
    PettyCashProposal,
)
from app.storage.base import StorageService, get_storage

router = APIRouter(prefix="/api/v1/petty-cash", tags=["petty-cash"])
Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
User = Annotated[AuthenticatedUser, Depends(require_user)]
Storage = Annotated[StorageService, Depends(get_storage)]
AppSettings = Annotated[Settings, Depends(get_settings)]

_COLUMNS = (
    "id, transaction_id, txn_date, payment_to, payment_from, remarks, amount, "
    "content_type, original_name, created_at"
)


def _entry(r: Any) -> PettyCashEntry:
    return PettyCashEntry(
        id=r.id,
        transaction_id=r.transaction_id,
        txn_date=r.txn_date,
        payment_to=r.payment_to,
        payment_from=r.payment_from,
        remarks=r.remarks,
        amount=format(r.amount, "f"),
        content_type=r.content_type,
        original_name=r.original_name,
        created_at=r.created_at,
    )


def _audit(
    db: Session, ctx: EmployerContext, user: AuthenticatedUser, eid: uuid.UUID, action: str
) -> None:
    """No receipt text or amounts in the audit trail: only what happened to which entry."""
    db.execute(
        text(
            "INSERT INTO audit_events "
            "(employer_id, actor, entity_type, entity_id, action, details) "
            "VALUES (:e, :actor, 'petty_cash_entry', :id, :action, CAST(:d AS jsonb))"
        ),
        {
            "e": ctx.employer_id,
            "actor": user.email or str(user.auth_user_id),
            "id": eid,
            "action": action,
            "d": json.dumps({}),
        },
    )


def _load(db: Session, entry_id: uuid.UUID) -> Any:
    row = db.execute(
        text(f"SELECT {_COLUMNS}, storage_key FROM petty_cash_entries WHERE id = :id"),
        {"id": entry_id},
    ).one_or_none()
    if row is None:  # also what another employer's id looks like (RLS)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    return row


def _best_effort_delete(storage: StorageService, bucket: str, key: str) -> None:
    try:
        storage.delete(bucket, key)
    except Exception:  # an orphaned private object is harmless; never fail the request for it
        logging.getLogger(__name__).warning("could not delete a receipt object")


@router.post(
    "/extract",
    operation_id="extractPettyCashReceipt",
    summary="Read a receipt into proposed fields (nothing is saved)",
)
def extract(file: UploadFile, user: User, ctx: Ctx) -> PettyCashProposal:
    raw = files.read_upload(file.file.read(files.RECEIPT_MAX_BYTES + 1))
    content_type = files.check_receipt(raw)
    try:
        parsed = parse_receipt(files.receipt_text(raw, content_type))
        text_read = True
    except (OcrUnavailable, OcrError) as exc:
        # Why, for the server log only (never the receipt's content): "not installed/off" vs a
        # recognition failure such as a timeout.
        cause = exc.__cause__
        logging.getLogger(__name__).warning(
            "receipt text could not be read: %s: %s (cause: %s)",
            type(exc).__name__,
            exc,
            type(cause).__name__ if cause else "none",
        )
        parsed = parse_receipt("")
        text_read = False
    duplicate = False
    if parsed.transaction_id:
        with tenant_session(ctx.employer_id) as db:
            duplicate = bool(
                db.execute(
                    text("SELECT 1 FROM petty_cash_entries WHERE transaction_id = :t LIMIT 1"),
                    {"t": parsed.transaction_id},
                ).first()
            )
    return PettyCashProposal(
        transaction_id=parsed.transaction_id,
        txn_date=parsed.txn_date,
        payment_to=parsed.payment_to,
        payment_from=parsed.payment_from,
        remarks=parsed.remarks,
        amount=parsed.amount,
        found=parsed.found(),
        text_read=text_read,
        duplicate=duplicate,
    )


@router.post(
    "",
    operation_id="createPettyCashEntry",
    summary="Save a reviewed entry together with its receipt",
    status_code=status.HTTP_201_CREATED,
)
def create_entry(
    file: UploadFile,
    fields: Annotated[str, Form(description="JSON of the reviewed fields")],
    user: User,
    ctx: Ctx,
    storage: Storage,
    app_settings: AppSettings,
) -> PettyCashEntry:
    try:
        data = PettyCashFields.model_validate_json(fields)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[
                {"loc": ["body", *map(str, e["loc"])], "msg": e["msg"], "type": e["type"]}
                for e in exc.errors(include_url=False, include_context=False, include_input=False)
            ],
        ) from None
    raw = files.read_upload(file.file.read(files.RECEIPT_MAX_BYTES + 1))
    content_type = files.check_receipt(raw)
    key = f"{ctx.employer_id}/petty-cash/{uuid.uuid4()}"
    storage.put(app_settings.receipts_bucket, key, raw, content_type)
    try:
        with tenant_session(ctx.employer_id) as db:
            row = db.execute(
                text(
                    "INSERT INTO petty_cash_entries (employer_id, transaction_id, txn_date, "
                    "payment_to, payment_from, remarks, amount, storage_key, content_type, "
                    "original_name) VALUES (:e, :t, :d, :to, :fr, :re, :am, :k, :ct, :n) "
                    f"RETURNING {_COLUMNS}"
                ),
                {
                    "e": ctx.employer_id,
                    "t": data.transaction_id,
                    "d": data.txn_date,
                    "to": data.payment_to,
                    "fr": data.payment_from,
                    "re": data.remarks,
                    "am": data.amount,
                    "k": key,
                    "ct": content_type,
                    "n": files.clean_name(file.filename),
                },
            ).one()
            _audit(db, ctx, user, row.id, "petty_cash_created")
            return _entry(row)
    except Exception:
        _best_effort_delete(storage, app_settings.receipts_bucket, key)
        raise


@router.get("", operation_id="listPettyCash", summary="Saved petty-cash entries")
def list_entries(
    ctx: Ctx,
    q: Annotated[str | None, Query(max_length=100)] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PettyCashList:
    where = ["TRUE"]
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append(
            "(transaction_id ILIKE :q OR payment_to ILIKE :q OR payment_from ILIKE :q "
            "OR remarks ILIKE :q)"
        )
        params["q"] = f"%{escaped}%"
    if date_from:
        where.append("txn_date >= :date_from")
        params["date_from"] = date_from
    if date_to:
        where.append("txn_date <= :date_to")
        params["date_to"] = date_to
    clause = " AND ".join(where)  # only constant fragments; values are bound parameters
    with tenant_session(ctx.employer_id) as db:
        agg = db.execute(
            text(
                "SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total "
                f"FROM petty_cash_entries WHERE {clause}"
            ),
            params,
        ).one()
        rows = db.execute(
            text(
                f"SELECT {_COLUMNS} FROM petty_cash_entries WHERE {clause} "
                "ORDER BY txn_date DESC NULLS LAST, created_at DESC, id LIMIT :limit OFFSET :offset"
            ),
            params,
        ).all()
    return PettyCashList(
        items=[_entry(r) for r in rows],
        total=int(agg.n),
        total_amount=format(agg.total, "f"),
    )


@router.get("/{entry_id}", operation_id="getPettyCashEntry", summary="One entry")
def get_entry(entry_id: uuid.UUID, ctx: Ctx) -> PettyCashEntry:
    with tenant_session(ctx.employer_id) as db:
        return _entry(_load(db, entry_id))


@router.put("/{entry_id}", operation_id="updatePettyCashEntry", summary="Edit an entry")
def update_entry(
    entry_id: uuid.UUID, body: PettyCashFields, user: User, ctx: Ctx
) -> PettyCashEntry:
    with tenant_session(ctx.employer_id) as db:
        _load(db, entry_id)
        row = db.execute(
            text(
                "UPDATE petty_cash_entries SET transaction_id = :t, txn_date = :d, "
                "payment_to = :to, payment_from = :fr, remarks = :re, amount = :am "
                f"WHERE id = :id RETURNING {_COLUMNS}"
            ),
            {
                "id": entry_id,
                "t": body.transaction_id,
                "d": body.txn_date,
                "to": body.payment_to,
                "fr": body.payment_from,
                "re": body.remarks,
                "am": body.amount,
            },
        ).one()
        _audit(db, ctx, user, entry_id, "petty_cash_edited")
        return _entry(row)


@router.delete(
    "/{entry_id}",
    operation_id="deletePettyCashEntry",
    summary="Delete an entry and its receipt",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_entry(
    entry_id: uuid.UUID, user: User, ctx: Ctx, storage: Storage, app_settings: AppSettings
) -> None:
    with tenant_session(ctx.employer_id) as db:
        row = _load(db, entry_id)
        db.execute(text("DELETE FROM petty_cash_entries WHERE id = :id"), {"id": entry_id})
        _audit(db, ctx, user, entry_id, "petty_cash_deleted")
        key = row.storage_key
    _best_effort_delete(storage, app_settings.receipts_bucket, key)


@router.get(
    "/{entry_id}/receipt",
    operation_id="getPettyCashReceipt",
    summary="The receipt file (authenticated; owner only)",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
def get_receipt(
    entry_id: uuid.UUID, ctx: Ctx, storage: Storage, app_settings: AppSettings
) -> Response:
    with tenant_session(ctx.employer_id) as db:
        row = _load(db, entry_id)
    if not row.storage_key.startswith(f"{ctx.employer_id}/"):  # defence in depth
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No receipt")
    data = storage.get(app_settings.receipts_bucket, row.storage_key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No receipt")
    return Response(
        content=data,
        media_type=row.content_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
