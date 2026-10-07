"""Creating an employer's workspace: employer + company profile + payment settings, ONE transaction.

Used by BOTH the operator CLI (app/provisioning.py) and self sign-up (POST /api/v1/account/setup),
so the two paths can never drift apart. Nothing here accepts an employer id from a caller: the
employer id is generated, and the owning auth user id comes from a verified session or the operator.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, text

from app.modules.collections.rules import parse_contact_phone

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class WorkspaceError(Exception):
    """Something the user or operator can fix; the message is safe to show."""


@dataclass(frozen=True)
class NewWorkspace:
    email: str
    full_name: str
    company_name: str
    phone: str | None = None


def clean_workspace(
    *, email: str | None, full_name: str | None, company_name: str | None, phone: str | None = None
) -> NewWorkspace:
    """Validate and normalise the four sign-up fields (server-side: the browser is not trusted)."""
    email_n = (email or "").strip().lower()
    if not _EMAIL_RE.match(email_n) or len(email_n) > 254:
        raise WorkspaceError("Enter a valid email address.")
    name = re.sub(r"\s+", " ", full_name or "").strip()
    if not 2 <= len(name) <= 80:
        raise WorkspaceError("Enter your full name (2 to 80 characters).")
    company = re.sub(r"\s+", " ", company_name or "").strip()
    if not 2 <= len(company) <= 60:
        raise WorkspaceError("Enter your company name (2 to 60 characters).")
    phone_n: str | None = None
    if phone and phone.strip():
        phone_n, err = parse_contact_phone(phone)
        if err:
            raise WorkspaceError("Enter a valid phone number.")
    return NewWorkspace(email_n, name, company, phone_n)


def workspace_from_identity(email: str | None, metadata: dict[str, Any]) -> NewWorkspace:
    """Names come from the sign-up form (stored by Supabase as user metadata). If an account was
    made some other way and has none, fall back to the email address so nobody is locked out:
    the company name can be edited later in Settings."""
    local = (email or "").split("@", 1)[0].strip()
    fallback = local if len(local) >= 2 else "My company"

    def text_of(key: str) -> str | None:
        v = metadata.get(key)
        return v if isinstance(v, str) and v.strip() else None

    return clean_workspace(
        email=email,
        full_name=text_of("full_name") or fallback,
        company_name=text_of("company_name") or text_of("full_name") or fallback,
        phone=text_of("phone"),
    )


def create_workspace(
    conn: Connection,
    ws: NewWorkspace,
    auth_user_id: uuid.UUID,
    *,
    actor: str,
    action: str,
    details: dict[str, str],
) -> tuple[uuid.UUID, bool]:
    """Idempotent per auth user. Returns (employer_id, created). All rows or none: the caller wraps
    this in one transaction (`engine.begin()`), so a failure never leaves a half-made tenant."""
    clash = conn.execute(
        text("SELECT 1 FROM employers WHERE lower(email) = :e AND auth_user_id <> :a"),
        {"e": ws.email, "a": auth_user_id},
    ).first()
    if clash:
        raise WorkspaceError("An account with this email already exists.")
    row = conn.execute(
        text(
            "INSERT INTO employers (auth_user_id, name, email, phone) "
            "VALUES (:a, :n, :e, :p) ON CONFLICT (auth_user_id) DO NOTHING RETURNING id"
        ),
        {"a": auth_user_id, "n": ws.full_name, "e": ws.email, "p": ws.phone},
    ).first()
    if row is None:  # already set up (a second tab, a retry): change nothing
        existing = conn.execute(
            text("SELECT id FROM employers WHERE auth_user_id = :a"), {"a": auth_user_id}
        ).scalar_one()
        return uuid.UUID(str(existing)), False
    employer_id = uuid.UUID(str(row.id))
    conn.execute(
        text("INSERT INTO company_profiles (employer_id, display_name) VALUES (:e, :n)"),
        {"e": employer_id, "n": ws.company_name},
    )
    conn.execute(text("INSERT INTO payment_settings (employer_id) VALUES (:e)"), {"e": employer_id})
    conn.execute(
        text(
            "INSERT INTO audit_events "
            "(employer_id, actor, entity_type, entity_id, action, details) "
            "VALUES (:e, :actor, 'employer', :e, :action, CAST(:d AS jsonb))"
        ),
        {"e": employer_id, "actor": actor, "action": action, "d": _json(details)},
    )
    return employer_id, True


def _json(obj: dict[str, str]) -> str:
    import json

    return json.dumps(obj)
