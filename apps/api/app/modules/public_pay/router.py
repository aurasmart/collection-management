"""The customer-facing payment page. NO login: the unguessable token in the URL is the only key.

It shows what the employer typed in Settings (UPI ID, the one general QR image, bank details)
next to this customer's amount. It never processes, collects or verifies a payment.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import Settings, get_settings
from app.core.db import get_engine
from app.core.ratelimit import client_ip, public_miss_limiter, public_page_limiter, too_many
from app.storage.base import StorageService, get_storage

router = APIRouter(prefix="/api/v1/public/pay", tags=["public"])
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND, detail="This payment page is unavailable."
)


class BankDetails(BaseModel):
    bank_name: str | None
    account_name: str | None
    account_number: str
    ifsc: str | None


class PublicPage(BaseModel):
    state: Literal["PENDING", "PAID"]
    company_name: str
    customer_name: str
    # Everything below is only filled in while the customer still owes money.
    amount_due: str | None = None
    reference: str | None = None
    upi_id: str | None = None
    upi_number: str | None = None
    has_qr: bool = False
    bank: BankDetails | None = None


_NO_STORE = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"}


def _lookup(token: str, request: Request) -> Any:
    ip = client_ip(request)
    if (wait := public_page_limiter.check(ip)) is not None:
        raise too_many(wait)
    row = None
    if _TOKEN_RE.match(token):  # anything else is simply "unavailable", never a validation error
        with get_engine().connect() as conn:
            row = conn.execute(
                text("SELECT * FROM public_payment_page(:t)"), {"t": token}
            ).one_or_none()
    if row is None or row.status not in ("PENDING", "PAID"):
        # Guessing tokens is the only reason to miss, so misses are limited much harder.
        if (wait := public_miss_limiter.check(ip)) is not None:
            raise too_many(wait)
        raise _NOT_FOUND  # same answer for unknown, malformed and cancelled
    return row


@router.get("/{token}", operation_id="getPublicPaymentPage", summary="What the customer sees")
def get_public_page(token: str, request: Request, response: Response) -> PublicPage:
    response.headers.update(_NO_STORE)
    row = _lookup(token, request)
    if row.status == "PAID":
        return PublicPage(
            state="PAID", company_name=row.company_name, customer_name=row.customer_name
        )
    bank = (
        BankDetails(
            bank_name=row.bank_name,
            account_name=row.account_name,
            account_number=row.account_number,
            ifsc=row.ifsc,
        )
        if row.account_number
        else None
    )
    return PublicPage(
        state="PENDING",
        company_name=row.company_name,
        customer_name=row.customer_name,
        amount_due=format(row.amount_due, "f"),
        reference=row.reference,
        upi_id=row.upi_id,
        upi_number=row.upi_number,
        has_qr=row.has_qr,
        bank=bank,
    )


@router.get(
    "/{token}/qr",
    operation_id="getPublicPaymentQr",
    summary="The company's general QR image, exactly as uploaded in Settings",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}, 404: {"description": "No QR"}},
)
def get_public_qr(
    token: str,
    request: Request,
    storage: Annotated[StorageService, Depends(get_storage)],
    app_settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    row = _lookup(token, request)
    if row.status != "PENDING" or not row.has_qr or not row.qr_key:
        raise _NOT_FOUND
    if not re.fullmatch(r"[0-9a-f-]{36}/qr/[0-9a-f-]{36}\.png", row.qr_key):
        raise _NOT_FOUND  # defence in depth: only our own key layout is ever read
    data = storage.get(app_settings.qr_bucket, row.qr_key)
    if data is None:
        raise _NOT_FOUND
    return Response(
        content=data,
        media_type="image/png",
        headers={**_NO_STORE, "X-Content-Type-Options": "nosniff"},
    )
