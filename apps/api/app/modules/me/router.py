import uuid

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.tenancy import TenantDb

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
