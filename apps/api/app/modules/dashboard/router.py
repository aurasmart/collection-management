from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Any

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
    due_date: date | None = None


class DashboardOut(BaseModel):
    total_outstanding: str
    pending_customers: int
    paid_amount: str
    customers: int
    # Insight numbers (all derived from the same two statuses; nothing new is stored).
    overdue_amount: str = "0.00"
    overdue_customers: int = 0
    due_soon_amount: str = "0.00"  # pending, due within the next 7 days
    due_soon_customers: int = 0
    paid_customers: int = 0
    top_outstanding: list[RecentRow] = []
    recent: list[RecentRow]


def _recent(r: Any) -> RecentRow:
    return RecentRow(
        id=r.id,
        customer_name=r.name,
        amount_due=format(r.amount_due, "f"),
        status=r.status,
        due_date=r.due_date,
    )


@router.get(
    "",
    operation_id="getDashboard",
    summary="The headline numbers, a few insights and the latest customers",
)
def get_dashboard(ctx: Annotated[EmployerContext, Depends(get_employer_context)]) -> DashboardOut:
    with tenant_session(ctx.employer_id) as db:
        totals = db.execute(
            text(
                "SELECT COALESCE(SUM(amount_due) FILTER (WHERE status = 'PENDING'), 0.00) "
                "AS outstanding, "
                "count(*) FILTER (WHERE status = 'PENDING') AS pending, "
                "COALESCE(SUM(amount_due) FILTER (WHERE status = 'PAID'), 0.00) AS paid, "
                "count(*) FILTER (WHERE status = 'PAID') AS paid_customers, "
                "COALESCE(SUM(amount_due) FILTER (WHERE status = 'PENDING' "
                "AND due_date < CURRENT_DATE), 0.00) AS overdue_amount, "
                "count(*) FILTER (WHERE status = 'PENDING' AND due_date < CURRENT_DATE) "
                "AS overdue_customers, "
                "COALESCE(SUM(amount_due) FILTER (WHERE status = 'PENDING' "
                "AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7), 0.00) AS soon_amount, "
                "count(*) FILTER (WHERE status = 'PENDING' "
                "AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS soon_customers, "
                "count(*) AS customers FROM collections WHERE status IN ('PENDING', 'PAID')"
            )
        ).one()
        top = db.execute(
            text(
                "SELECT c.id, cu.name, c.amount_due, c.status, c.due_date FROM collections c "
                "JOIN customers cu ON cu.id = c.customer_id AND cu.employer_id = c.employer_id "
                "WHERE c.status = 'PENDING' ORDER BY c.amount_due DESC, c.id LIMIT 5"
            )
        ).all()
        recent = db.execute(
            text(
                "SELECT c.id, cu.name, c.amount_due, c.status, c.due_date FROM collections c "
                "JOIN customers cu ON cu.id = c.customer_id AND cu.employer_id = c.employer_id "
                "WHERE c.status IN ('PENDING', 'PAID') ORDER BY c.updated_at DESC, c.id LIMIT 10"
            )
        ).all()
    return DashboardOut(
        total_outstanding=format(totals.outstanding, "f"),
        pending_customers=totals.pending,
        paid_amount=format(totals.paid, "f"),
        customers=totals.customers,
        paid_customers=totals.paid_customers,
        overdue_amount=format(totals.overdue_amount, "f"),
        overdue_customers=totals.overdue_customers,
        due_soon_amount=format(totals.soon_amount, "f"),
        due_soon_customers=totals.soon_customers,
        top_outstanding=[_recent(r) for r in top],
        recent=[_recent(r) for r in recent],
    )
