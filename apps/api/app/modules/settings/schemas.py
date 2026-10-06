"""Payment settings schemas. Field rules follow docs/stage-2-ui-ux.md §19 (S10).

`extra="forbid"`: any unexpected field (for example a forged `employer_id`) is a 422, never ignored.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

UPI_ID_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$")
UPI_NUMBER_RE = re.compile(r"^[6-9][0-9]{9}$")
ACCOUNT_NUMBER_RE = re.compile(r"^[0-9]{9,18}$")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")

Trimmed = Annotated[str, StringConstraints(strip_whitespace=True)]


def _blank_to_none(v: Any) -> Any:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


class PaymentSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)
    ]
    upi_id: str | None = None
    upi_number: str | None = None
    bank_name: str | None = None
    account_name: str | None = None
    account_number: str | None = None
    ifsc: str | None = None
    upi_enabled: bool = False
    upi_number_enabled: bool = False
    qr_enabled: bool = False
    bank_enabled: bool = False

    @field_validator(
        "upi_id", "upi_number", "bank_name", "account_name", "account_number", "ifsc", mode="before"
    )
    @classmethod
    def _blank(cls, v: Any) -> Any:
        return _blank_to_none(v)

    @field_validator("upi_id")
    @classmethod
    def _upi_id(cls, v: str | None) -> str | None:
        if v is not None and not UPI_ID_RE.match(v):
            raise ValueError("Enter a valid UPI ID, like name@bank")
        return v

    @field_validator("upi_number")
    @classmethod
    def _upi_number(cls, v: str | None) -> str | None:
        if v is not None and not UPI_NUMBER_RE.match(v):
            raise ValueError("Enter a 10-digit mobile number starting with 6, 7, 8 or 9")
        return v

    @field_validator("bank_name")
    @classmethod
    def _bank_name(cls, v: str | None) -> str | None:
        if v is not None and not 2 <= len(v) <= 60:
            raise ValueError("Bank name must be 2 to 60 characters")
        return v

    @field_validator("account_name")
    @classmethod
    def _account_name(cls, v: str | None) -> str | None:
        if v is not None and not 2 <= len(v) <= 80:
            raise ValueError("Account holder name must be 2 to 80 characters")
        return v

    @field_validator("account_number")
    @classmethod
    def _account_number(cls, v: str | None) -> str | None:
        if v is not None and not ACCOUNT_NUMBER_RE.match(v):
            raise ValueError("Account number must be 9 to 18 digits")
        return v

    @field_validator("ifsc")
    @classmethod
    def _ifsc(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.upper()
        if not IFSC_RE.match(v):
            raise ValueError("Enter a valid IFSC, like HDFC0001234")
        return v


class SettingChange(BaseModel):
    at: datetime
    actor: str
    fields: list[str]


class PaymentSettingsOut(BaseModel):
    display_name: str | None
    upi_id: str | None
    upi_number: str | None
    bank_name: str | None
    account_name: str | None
    account_number: str | None
    ifsc: str | None
    upi_enabled: bool
    upi_number_enabled: bool
    qr_enabled: bool
    bank_enabled: bool
    has_qr: bool
    updated_at: datetime | None
    recent_changes: list[SettingChange]
