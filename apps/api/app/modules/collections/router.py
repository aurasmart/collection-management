"""Collections = the employer's customers and what they owe. Status is just PENDING or PAID."""

from __future__ import annotations

import json
import secrets
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.db import tenant_session
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.collections.rules import validate_row

router = APIRouter(prefix="/api/v1/collections", tags=["collections"])
Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
User = Annotated[AuthenticatedUser, Depends(require_user)]

Status = Literal["PENDING", "PAID"]
Sort = Literal[
    "created_desc",
    "created_asc",
    "due_asc",
    "due_desc",
    "amount_desc",
    "amount_asc",
    "name_asc",
    "name_desc",
]
YesNo = Literal["yes", "no"]

# Whitelist: the `sort` query value only ever selects one of these constant fragments.
_ORDER = {
    "created_desc": "c.created_at DESC",
    "created_asc": "c.created_at ASC",
    "due_asc": "c.due_date ASC NULLS LAST",
    "due_desc": "c.due_date DESC NULLS LAST",
    "amount_desc": "c.amount_due DESC",
    "amount_asc": "c.amount_due ASC",
    "name_asc": "lower(cu.name) ASC",
    "name_desc": "lower(cu.name) DESC",
}

_SELECT = (
    "SELECT c.id, cu.name AS customer_name, cu.phone, c.amount_due, c.due_date, c.reference, "
    "c.status, c.payment_token, c.created_at, c.updated_at "
    "FROM collections c JOIN customers cu "
    "ON cu.id = c.customer_id AND cu.employer_id = c.employer_id"
)


_COUNT = (
    "SELECT count(*) FROM collections c JOIN customers cu "
    "ON cu.id = c.customer_id AND cu.employer_id = c.employer_id"
)


class CollectionRow(BaseModel):
    id: uuid.UUID
    customer_name: str
    phone: str | None
    amount_due: str
    due_date: date | None
    reference: str | None
    status: Status
    has_payment_page: bool
    created_at: datetime


class CollectionList(BaseModel):
    items: list[CollectionRow]
    total: int


class CollectionDetail(CollectionRow):
    # The payment-page token, only ever returned to the signed-in owner of this record.
    payment_token: str | None
    updated_at: datetime


class DeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


class DeleteResult(BaseModel):
    deleted: int


class CollectionEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_name: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=50)
    amount_due: str | None = Field(default=None, max_length=50)
    reference: str | None = Field(default=None, max_length=300)
    due_date: str | None = Field(default=None, max_length=50)


def _row(r: Any) -> dict[str, Any]:
    return {
        "id": r.id,
        "customer_name": r.customer_name,
        "phone": r.phone,
        "amount_due": format(r.amount_due, "f"),
        "due_date": r.due_date,
        "reference": r.reference,
        "status": r.status,
        "has_payment_page": r.payment_token is not None,
        "created_at": r.created_at,
    }


def _detail(r: Any) -> CollectionDetail:
    return CollectionDetail(**_row(r), payment_token=r.payment_token, updated_at=r.updated_at)


def _load(db: Session, collection_id: uuid.UUID, *, lock: bool = False) -> Any:
    sql = f"{_SELECT} WHERE c.id = :id" + (" FOR UPDATE OF c" if lock else "")
    row = db.execute(text(sql), {"id": collection_id}).one_or_none()
    if row is None:  # also what another employer's id looks like (RLS)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return row


def _audit(db: Session, ctx: EmployerContext, user: AuthenticatedUser, cid: uuid.UUID, action: str,
           details: dict[str, Any]) -> None:  # fmt: skip
    db.execute(
        text(
            "INSERT INTO audit_events "
            "(employer_id, actor, entity_type, entity_id, action, details) "
            "VALUES (:e, :actor, 'collection', :id, :action, CAST(:d AS jsonb))"
        ),
        {
            "e": ctx.employer_id,
            "actor": user.email or str(user.auth_user_id),
            "id": cid,
            "action": action,
            "d": json.dumps(details),
        },
    )


@router.get("", operation_id="listCollections", summary="Customers and what they owe")
def list_collections(
    ctx: Ctx,
    status_filter: Annotated[Status | None, Query(alias="status")] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    sort: Sort = "created_desc",
    overdue: bool = False,
    due_from: date | None = None,
    due_to: date | None = None,
    min_amount: Annotated[Decimal | None, Query(ge=0, max_digits=14, decimal_places=2)] = None,
    max_amount: Annotated[Decimal | None, Query(ge=0, max_digits=14, decimal_places=2)] = None,
    created_from: date | None = None,
    created_to: date | None = None,
    payment_page: YesNo | None = None,
    has_phone: YesNo | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CollectionList:
    where = ["TRUE"]
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if status_filter:
        where.append("c.status = :status")
        params["status"] = status_filter
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append("(cu.name ILIKE :q OR cu.phone ILIKE :q OR c.reference ILIKE :q)")
        params["q"] = f"%{escaped}%"
    if overdue:
        where.append("c.status = 'PENDING' AND c.due_date < CURRENT_DATE")
    if due_from:
        where.append("c.due_date >= :due_from")
        params["due_from"] = due_from
    if due_to:
        where.append("c.due_date <= :due_to")
        params["due_to"] = due_to
    if min_amount is not None:
        where.append("c.amount_due >= :min_amount")
        params["min_amount"] = min_amount
    if max_amount is not None:
        where.append("c.amount_due <= :max_amount")
        params["max_amount"] = max_amount
    if created_from:
        where.append("c.created_at >= :created_from")
        params["created_from"] = created_from
    if created_to:  # inclusive of the whole last day
        where.append("c.created_at < CAST(:created_to AS date) + 1")
        params["created_to"] = created_to
    if payment_page:
        where.append(
            "c.payment_token IS NOT NULL" if payment_page == "yes" else "c.payment_token IS NULL"
        )
    if has_phone:
        where.append(
            "(cu.phone IS NOT NULL AND cu.phone <> '')"
            if has_phone == "yes"
            else "(cu.phone IS NULL OR cu.phone = '')"
        )
    clause = " AND ".join(where)  # built only from the constant fragments above
    with tenant_session(ctx.employer_id) as db:
        count_sql = f"{_COUNT} WHERE {clause}"  # noqa: S608
        total = db.execute(text(count_sql), params).scalar_one()
        rows = db.execute(
            text(
                f"{_SELECT} WHERE {clause} "
                f"ORDER BY {_ORDER[sort]}, c.id LIMIT :limit OFFSET :offset"
            ),  # noqa: S608
            params,
        ).all()
    return CollectionList(items=[CollectionRow(**_row(r)) for r in rows], total=total)


def _delete_collections(
    db: Session, ctx: EmployerContext, user: AuthenticatedUser, ids: list[uuid.UUID]
) -> int:
    """Delete the employer's own collections and their per-row customers; other ids are skipped."""
    deleted = 0
    for cid in dict.fromkeys(ids):
        row = db.execute(
            text(f"{_SELECT} WHERE c.id = :id FOR UPDATE OF c"), {"id": cid}
        ).one_or_none()
        if row is None:
            continue
        db.execute(
            text(
                "UPDATE import_rows SET duplicate_of_collection_id = NULL "
                "WHERE duplicate_of_collection_id = :id"
            ),
            {"id": cid},
        )
        customer_id = db.execute(
            text("SELECT customer_id FROM collections WHERE id = :id"), {"id": cid}
        ).scalar_one()
        db.execute(text("DELETE FROM collections WHERE id = :id"), {"id": cid})
        db.execute(
            text(
                "DELETE FROM customers WHERE id = :cu AND NOT EXISTS "
                "(SELECT 1 FROM collections WHERE customer_id = :cu)"
            ),
            {"cu": customer_id},
        )
        # name and amount for the record; never the payment token
        _audit(
            db,
            ctx,
            user,
            cid,
            "collection_deleted",
            {
                "customer_name": row.customer_name,
                "amount_due": format(row.amount_due, "f"),
                "status": row.status,
            },
        )
        deleted += 1
    return deleted


@router.post(
    "/delete",
    operation_id="deleteCollections",
    summary="Delete several of your customers at once (all or nothing)",
)
def delete_collections(body: DeleteRequest, user: User, ctx: Ctx) -> DeleteResult:
    with tenant_session(ctx.employer_id) as db:
        return DeleteResult(deleted=_delete_collections(db, ctx, user, body.ids))


@router.delete(
    "/{collection_id}",
    operation_id="deleteCollection",
    summary="Delete one customer",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_collection(collection_id: uuid.UUID, user: User, ctx: Ctx) -> None:
    with tenant_session(ctx.employer_id) as db:
        _load(db, collection_id)  # 404 for a missing id (or another employer's)
        _delete_collections(db, ctx, user, [collection_id])


@router.get("/{collection_id}", operation_id="getCollection", summary="One customer")
def get_collection(collection_id: uuid.UUID, ctx: Ctx) -> CollectionDetail:
    with tenant_session(ctx.employer_id) as db:
        return _detail(_load(db, collection_id))


@router.put("/{collection_id}", operation_id="updateCollection", summary="Edit a pending customer")
def update_collection(
    collection_id: uuid.UUID, body: CollectionEdit, user: User, ctx: Ctx
) -> CollectionDetail:
    result = validate_row(body.model_dump())
    if result.errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[
                {"loc": ["body", f], "msg": m, "type": "value_error"} for f, m in result.errors
            ],
        )
    with tenant_session(ctx.employer_id) as db:
        current = _load(db, collection_id, lock=True)
        if current.status != "PENDING":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="A paid customer can't be edited."
            )
        new = {
            "customer_name": result.customer_name,
            "phone": result.phone,
            "amount_due": result.amount_due,
            "reference": result.reference,
            "due_date": result.due_date,
        }
        old = {
            "customer_name": current.customer_name,
            "phone": current.phone,
            "amount_due": format(current.amount_due, "f"),
            "reference": current.reference,
            "due_date": current.due_date.isoformat() if current.due_date else None,
        }
        changed = [k for k in new if new[k] != old[k]]
        if changed:
            db.execute(
                text(
                    "UPDATE customers SET name = :name, phone = :phone "
                    "WHERE id = (SELECT customer_id FROM collections WHERE id = :id)"
                ),
                {"name": result.customer_name, "phone": result.phone, "id": collection_id},
            )
            db.execute(
                text(
                    "UPDATE collections SET amount_due = :amount, reference = :ref, "
                    "due_date = CAST(:due AS date) WHERE id = :id"
                ),
                {
                    "amount": result.amount_due,
                    "ref": result.reference,
                    "due": result.due_date,
                    "id": collection_id,
                },
            )
            _audit(db, ctx, user, collection_id, "collection_edited", {"fields": changed})
        return _detail(_load(db, collection_id))


@router.post(
    "/{collection_id}/payment-page",
    operation_id="generatePaymentPage",
    summary="Create this customer's payment-page link (the same link is returned if it exists)",
)
def generate_payment_page(collection_id: uuid.UUID, user: User, ctx: Ctx) -> CollectionDetail:
    with tenant_session(ctx.employer_id) as db:
        current = _load(db, collection_id, lock=True)
        if current.payment_token is None:
            db.execute(
                text("UPDATE collections SET payment_token = :t WHERE id = :id"),
                {"t": secrets.token_urlsafe(16), "id": collection_id},
            )
            # never put the token in the audit trail
            _audit(db, ctx, user, collection_id, "payment_page_created", {})
        return _detail(_load(db, collection_id))


@router.post(
    "/{collection_id}/mark-unpaid",
    operation_id="markCollectionUnpaid",
    summary="Undo a Mark as Paid click (a plain status correction, nothing else changes)",
)
def mark_unpaid(collection_id: uuid.UUID, user: User, ctx: Ctx) -> CollectionDetail:
    with tenant_session(ctx.employer_id) as db:
        current = _load(db, collection_id, lock=True)
        if current.status == "PAID":
            db.execute(
                text("UPDATE collections SET status = 'PENDING' WHERE id = :id"),
                {"id": collection_id},
            )
            _audit(db, ctx, user, collection_id, "marked_unpaid", {})
        return _detail(_load(db, collection_id))


@router.post(
    "/{collection_id}/mark-paid",
    operation_id="markCollectionPaid",
    summary="The employer confirms the money was received (manual, no verification)",
)
def mark_paid(collection_id: uuid.UUID, user: User, ctx: Ctx) -> CollectionDetail:
    with tenant_session(ctx.employer_id) as db:
        current = _load(db, collection_id, lock=True)
        if current.status == "PENDING":
            db.execute(
                text("UPDATE collections SET status = 'PAID' WHERE id = :id"), {"id": collection_id}
            )
            _audit(
                db,
                ctx,
                user,
                collection_id,
                "marked_paid",
                {"amount": format(current.amount_due, "f")},
            )
        return _detail(_load(db, collection_id))
