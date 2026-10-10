from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_AMOUNT = Decimal("99999999999.99")


def _clean(v: object) -> str | None:
    if v is None:
        return None
    s = " ".join(str(v).split())
    return s or None


class PettyCashFields(BaseModel):
    """What the employer reviewed and confirmed. Empty text becomes null; amount is required."""

    model_config = ConfigDict(extra="forbid")
    transaction_id: str | None = Field(default=None, max_length=100)
    txn_date: date | None = None
    payment_to: str | None = Field(default=None, max_length=300)
    payment_from: str | None = Field(default=None, max_length=300)
    remarks: str | None = Field(default=None, max_length=500)
    amount: str = Field(max_length=30)

    @field_validator("transaction_id", "payment_to", "payment_from", "remarks", mode="before")
    @classmethod
    def _text(cls, v: object) -> str | None:
        return _clean(v)

    @field_validator("amount", mode="before")
    @classmethod
    def _amount(cls, v: object) -> str:
        raw = str(v if v is not None else "").replace(",", "").replace("₹", "").strip()
        try:
            value = Decimal(raw)
        except InvalidOperation:
            raise ValueError("Enter the amount as a number, e.g. 1,250.00") from None
        if not value.is_finite() or value <= 0:
            raise ValueError("Amount must be more than 0")
        if value > MAX_AMOUNT:
            raise ValueError("This amount is too large")
        if value != value.quantize(Decimal("0.01")):
            raise ValueError("Use at most 2 decimal places")
        return format(value.quantize(Decimal("0.01")), "f")


class PettyCashEntry(BaseModel):
    id: uuid.UUID
    transaction_id: str | None
    txn_date: date | None
    payment_to: str | None
    payment_from: str | None
    remarks: str | None
    amount: str
    content_type: str
    original_name: str | None
    created_at: datetime


class PettyCashList(BaseModel):
    items: list[PettyCashEntry]
    total: int
    total_amount: str


class PettyCashProposal(BaseModel):
    """Proposed values read from a receipt. Nothing is saved until the employer confirms."""

    transaction_id: str | None
    txn_date: date | None
    payment_to: str | None
    payment_from: str | None
    remarks: str | None
    amount: str | None
    found: list[str]
    text_read: bool  # false: the text on the file could not be read; fill the form by hand
    duplicate: bool  # an entry with this transaction id is already saved
