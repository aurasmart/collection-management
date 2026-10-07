"""Company profile schemas. `extra="forbid"` makes a forged `employer_id` a 422."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

from app.modules.collections.rules import parse_contact_phone

PIN_RE = re.compile(r"^[1-9][0-9]{5}$")
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Fields a customer can see on the payment page: changing them needs a recent password check.
CUSTOMER_VISIBLE_FIELDS = (
    "display_name",
    "address",
    "city",
    "state",
    "pin",
    "gstin",
    "phone",
    "email",
)
INTERNAL_FIELDS = ("legal_name", "pan", "contact_person", "website")
EDITABLE_FIELDS = (*CUSTOMER_VISIBLE_FIELDS, *INTERNAL_FIELDS)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)]


def _blank_to_none(v: Any) -> Any:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def _max(v: str | None, n: int, label: str) -> str | None:
    if v is not None and len(v) > n:
        raise ValueError(f"{label} must be {n} characters or fewer")
    return v


class CompanyProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: Name
    legal_name: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pin: str | None = None
    gstin: str | None = None
    pan: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    website: str | None = None

    @field_validator(*EDITABLE_FIELDS[1:], mode="before")
    @classmethod
    def _blank(cls, v: Any) -> Any:
        return _blank_to_none(v)

    @field_validator("legal_name")
    @classmethod
    def _legal(cls, v: str | None) -> str | None:
        return _max(v, 120, "Legal name")

    @field_validator("address")
    @classmethod
    def _address(cls, v: str | None) -> str | None:
        return _max(v, 200, "Address")

    @field_validator("city")
    @classmethod
    def _city(cls, v: str | None) -> str | None:
        return _max(v, 60, "City")

    @field_validator("state")
    @classmethod
    def _state(cls, v: str | None) -> str | None:
        return _max(v, 60, "State")

    @field_validator("contact_person")
    @classmethod
    def _person(cls, v: str | None) -> str | None:
        return _max(v, 80, "Contact person")

    @field_validator("pin")
    @classmethod
    def _pin(cls, v: str | None) -> str | None:
        if v is not None and not PIN_RE.match(v):
            raise ValueError("Enter a 6-digit PIN code")
        return v

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.upper()
        if not GSTIN_RE.match(v):
            raise ValueError("Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5")
        return v

    @field_validator("pan")
    @classmethod
    def _pan(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.upper()
        if not PAN_RE.match(v):
            raise ValueError("Enter a valid 10-character PAN, like ABCDE1234F")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        if v is None:
            return v
        value, error = parse_contact_phone(v)
        if error:
            raise ValueError(error)
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        if v is not None and (len(v) > 120 or not EMAIL_RE.match(v)):
            raise ValueError("Enter a valid email address")
        return v.lower() if v else v

    @field_validator("website")
    @classmethod
    def _website(cls, v: str | None) -> str | None:
        if v is None:
            return v
        candidate = v if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", v) else f"https://{v}"
        parsed = urlparse(candidate)
        if (
            len(candidate) > 200
            or parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or "." not in parsed.hostname
            or any(ch.isspace() for ch in candidate)
        ):
            raise ValueError("Enter a valid website address, like https://example.com")
        return candidate


class CompanyChange(BaseModel):
    at: datetime
    actor: str
    fields: list[str]


class CompanyProfileOut(BaseModel):
    display_name: str
    legal_name: str | None
    address: str | None
    city: str | None
    state: str | None
    pin: str | None
    gstin: str | None
    pan: str | None
    contact_person: str | None
    phone: str | None
    email: str | None
    website: str | None
    has_logo: bool
    saved: bool
    updated_at: datetime | None
    recent_changes: list[CompanyChange]
