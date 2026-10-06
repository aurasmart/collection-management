"""Database access.

Tenant isolation rule: every employer-scoped query runs inside `tenant_session`, which
(1) switches the transaction to the non-BYPASSRLS role `app_rls` and
(2) sets `app.employer_id` from the *verified* session — never from request data.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

TENANT_ROLE = "app_rls"


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def _sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(get_engine(), expire_on_commit=False)


def resolve_employer_id(auth_user_id: uuid.UUID) -> uuid.UUID | None:
    """Map a verified auth user to its employer (the only pre-tenant lookup).

    Uses the SECURITY DEFINER function so no tenant table is readable without a tenant context.
    """
    with _sessionmaker()() as session:
        row = session.execute(
            text("SELECT resolve_employer_id(:uid)"), {"uid": str(auth_user_id)}
        ).scalar_one()
    return uuid.UUID(str(row)) if row else None


@contextmanager
def tenant_session(employer_id: uuid.UUID) -> Iterator[Session]:
    """One transaction scoped to a single employer. Commits on success, rolls back on error."""
    with _sessionmaker()() as session, session.begin():
        session.execute(text(f"SET LOCAL ROLE {TENANT_ROLE}"))
        session.execute(
            text("SELECT set_config('app.employer_id', :eid, true)"), {"eid": str(employer_id)}
        )
        yield session


def check_database() -> bool:
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return False
    return True
