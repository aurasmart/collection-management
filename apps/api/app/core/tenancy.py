"""Tenant context. `employer_id` is derived ONLY from the verified session.

Never add a route parameter, query string, header or body field that supplies an employer id.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import resolve_employer_id, tenant_session
from app.core.security import AuthenticatedUser, require_user


@dataclass(frozen=True)
class EmployerContext:
    employer_id: uuid.UUID


def get_employer_context(
    user: Annotated[AuthenticatedUser, Depends(require_user)],
) -> EmployerContext:
    employer_id = resolve_employer_id(user.auth_user_id)
    if employer_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No workspace is linked to this account.",
        )
    return EmployerContext(employer_id=employer_id)


def get_tenant_db(
    ctx: Annotated[EmployerContext, Depends(get_employer_context)],
) -> Iterator[Session]:
    with tenant_session(ctx.employer_id) as session:
        yield session


TenantDb = Annotated[Session, Depends(get_tenant_db)]
