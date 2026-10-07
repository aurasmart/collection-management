from __future__ import annotations

import logging
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, status
from sqlalchemy import text

from app.core.config import Settings, get_settings
from app.core.db import tenant_session
from app.core.reauth import RecentAuthUser, ensure_recent_auth
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.company import service
from app.modules.company.schemas import CUSTOMER_VISIBLE_FIELDS, CompanyProfileIn, CompanyProfileOut
from app.modules.settings.service import write_audit
from app.storage.base import StorageService, get_storage

router = APIRouter(prefix="/api/v1/settings/company", tags=["settings"])

Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
Storage = Annotated[StorageService, Depends(get_storage)]
AppSettings = Annotated[Settings, Depends(get_settings)]

_REAUTH_RESPONSE: dict[int | str, dict[str, Any]] = {
    403: {"description": "Recent password confirmation required (reauth_required)"}
}
_ENTITY = "company_profile"


def _actor(user: AuthenticatedUser) -> str:
    return user.email or str(user.auth_user_id)


@router.get("", operation_id="getCompanyProfile", summary="Company profile (own employer only)")
def get_company_profile(ctx: Ctx) -> CompanyProfileOut:
    with tenant_session(ctx.employer_id) as db:
        return service.to_out(db, service.load_row(db))


@router.put(
    "",
    operation_id="updateCompanyProfile",
    summary="Save the company profile (customer-visible changes need a recent password check)",
    responses=_REAUTH_RESPONSE,
)
def update_company_profile(
    body: CompanyProfileIn,
    user: Annotated[AuthenticatedUser, Depends(require_user)],
    ctx: Ctx,
    app_settings: AppSettings,
) -> CompanyProfileOut:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
        fields = service.changed_fields(row, body, service.employer_name(db))
        visible = any(f in CUSTOMER_VISIBLE_FIELDS for f in fields)
        if visible:
            ensure_recent_auth(user, app_settings)
        if fields:
            profile_id = service.upsert(db, ctx.employer_id, body)
            write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=profile_id,
                fields=fields,
                reauthenticated=visible,
                entity_type=_ENTITY,
            )
        return service.to_out(db, service.load_row(db))


@router.put(
    "/logo",
    operation_id="uploadCompanyLogo",
    summary="Upload or replace the logo (PNG/JPG/WebP, max 2 MB, at least 64×64)",
    responses=_REAUTH_RESPONSE,
)
def upload_logo(
    file: UploadFile,
    user: RecentAuthUser,
    ctx: Ctx,
    storage: Storage,
    app_settings: AppSettings,
) -> CompanyProfileOut:
    raw = file.file.read(service.LOGO_MAX_BYTES + 1)
    png = service.process_logo(raw)
    key = f"{ctx.employer_id}/logo/{uuid.uuid4()}.png"
    storage.put(app_settings.qr_bucket, key, png, "image/png")
    old_key: str | None = None
    try:
        with tenant_session(ctx.employer_id) as db:
            service.ensure_row(db, ctx.employer_id)
            row = service.load_row(db)
            old_key = row["logo_key"] if row else None
            profile_id = db.execute(
                text("UPDATE company_profiles SET logo_key = :k RETURNING id"), {"k": key}
            ).scalar_one()
            write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=uuid.UUID(str(profile_id)),
                fields=["logo"],
                reauthenticated=True,
                entity_type=_ENTITY,
            )
            out = service.to_out(db, service.load_row(db))
    except Exception:
        storage.delete(app_settings.qr_bucket, key)
        raise
    if old_key:
        _best_effort_delete(storage, app_settings.qr_bucket, old_key)
    return out


@router.delete(
    "/logo",
    operation_id="deleteCompanyLogo",
    summary="Remove the logo",
    responses=_REAUTH_RESPONSE,
)
def delete_logo(
    user: RecentAuthUser, ctx: Ctx, storage: Storage, app_settings: AppSettings
) -> CompanyProfileOut:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
        old_key = row["logo_key"] if row else None
        if row and old_key:
            db.execute(text("UPDATE company_profiles SET logo_key = NULL"))
            write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=uuid.UUID(str(row["id"])),
                fields=["logo"],
                reauthenticated=True,
                entity_type=_ENTITY,
            )
        out = service.to_out(db, service.load_row(db))
    if old_key:
        _best_effort_delete(storage, app_settings.qr_bucket, old_key)
    return out


@router.get(
    "/logo",
    operation_id="getCompanyLogo",
    summary="The employer's own logo (authenticated; the public page has its own route)",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}, 404: {"description": "No logo"}},
)
def get_logo(ctx: Ctx, storage: Storage, app_settings: AppSettings) -> Response:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
    key = row["logo_key"] if row else None
    if not key or not key.startswith(f"{ctx.employer_id}/"):  # defence in depth
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No logo")
    data = storage.get(app_settings.qr_bucket, key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No logo")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


def _best_effort_delete(storage: StorageService, bucket: str, key: str) -> None:
    try:
        storage.delete(bucket, key)
    except Exception:  # an orphaned private object is harmless; never fail the request for it
        logging.getLogger(__name__).warning("could not delete replaced logo object")
