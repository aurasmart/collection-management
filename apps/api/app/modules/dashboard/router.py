from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text

from app.core.db import tenant_session
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.collections.router import Status

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])


class RecentRow(BaseModel):
    id: uuid.UUID
    customer_name: str
    amount_due: str
    status: Status


class DashboardOut(BaseModel):
    total_outstanding: str
    pending_customers: int
    paid_amount: str
    customers: int
    recent: list[RecentRow]


@router.get("", operation_id="getDashboard", summary="Four simple numbers and the latest customers")
def get_dashboard(ctx: Annotated[EmployerContext, Depends(get_employer_context)]) -> DashboardOut:
    with tenant_session(ctx.employer_id) as db:
        totals = db.execute(
            text(
                "SELECT COALESCE(SUM(amount_due) FILTER (WHERE status = 'PENDING'), 0.00) "
                "AS outstanding, "
                "count(*) FILTER (WHERE status = 'PENDING') AS pending, "
                "COALESCE(SUM(amount_due) FILTER (WHERE status = 'PAID'), 0.00) AS paid, "
                "count(*) AS customers FROM collections WHERE status IN ('PENDING', 'PAID')"
            )
        ).one()
        recent = db.execute(
            text(
                "SELECT c.id, cu.name, c.amount_due, c.status FROM collections c "
                "JOIN customers cu ON cu.id = c.customer_id AND cu.employer_id = c.employer_id "
                "WHERE c.status IN ('PENDING', 'PAID') ORDER BY c.updated_at DESC, c.id LIMIT 10"
            )
        ).all()
    return DashboardOut(
        total_outstanding=format(totals.outstanding, "f"),
        pending_customers=totals.pending,
        paid_amount=format(totals.paid, "f"),
        customers=totals.customers,
        recent=[
            RecentRow(
                id=r.id, customer_name=r.name, amount_due=format(r.amount_due, "f"), status=r.status
            )
            for r in recent
        ],
    )
