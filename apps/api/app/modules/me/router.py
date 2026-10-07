import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.db import get_engine
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import TenantDb
from app.workspace import (
    WorkspaceError,
    create_workspace,
    workspace_from_identity,
)

router = APIRouter(prefix="/api/v1", tags=["auth"])


class EmployerOut(BaseModel):
    id: uuid.UUID
    name: str
    email: str


class MeResponse(BaseModel):
    employer: EmployerOut


@router.get(
    "/me",
    operation_id="getMe",
    summary="Current employer (derived from the verified session)",
)
def get_me(db: TenantDb) -> MeResponse:
    # RLS limits this to the caller's own employer row.
    row = db.execute(text("SELECT id, name, email FROM employers")).one_or_none()
    if row is None:  # unreachable unless the tenant row vanished mid-request
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No workspace.")
    return MeResponse(employer=EmployerOut(id=row.id, name=row.name, email=row.email))


class SetupOut(BaseModel):
    created: bool  # False when the workspace already existed (a retry or a second tab)


@router.post(
    "/account/setup",
    operation_id="setupAccount",
    summary="Create the workspace for the signed-in user (first sign-in after sign up)",
)
def setup_account(user: Annotated[AuthenticatedUser, Depends(require_user)]) -> SetupOut:
    """Takes NO input: who the user is comes from the verified session, and the names come from the
    sign-up form data that Supabase stored on that same session. No employer id is ever accepted."""
    try:
        ws = workspace_from_identity(user.email, user.metadata)
        with get_engine().begin() as conn:
            _, created = create_workspace(
                conn,
                ws,
                user.auth_user_id,
                actor=ws.email,
                action="employer_signed_up",
                details={"method": "self_signup"},
            )
    except WorkspaceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from None
    return SetupOut(created=created)
