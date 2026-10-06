from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, status
from sqlalchemy import text

from app.core.config import Settings, get_settings
from app.core.db import tenant_session
from app.core.reauth import RecentAuthUser, ensure_recent_auth
from app.core.security import AuthenticatedUser, require_user
from app.core.tenancy import EmployerContext, get_employer_context
from app.modules.settings import service
from app.modules.settings.schemas import PaymentSettingsIn, PaymentSettingsOut
from app.storage.base import StorageService, get_storage

router = APIRouter(prefix="/api/v1/settings/payment", tags=["settings"])

Ctx = Annotated[EmployerContext, Depends(get_employer_context)]
Storage = Annotated[StorageService, Depends(get_storage)]
AppSettings = Annotated[Settings, Depends(get_settings)]

_REAUTH_RESPONSE: dict[int | str, dict[str, Any]] = {
    403: {"description": "Recent password confirmation required (reauth_required)"}
}


def _actor(user: AuthenticatedUser) -> str:
    return user.email or str(user.auth_user_id)


@router.get("", operation_id="getPaymentSettings", summary="Payment settings (own employer only)")
def get_payment_settings(ctx: Ctx) -> PaymentSettingsOut:
    with tenant_session(ctx.employer_id) as db:
        return service.to_out(db, service.load_row(db))


@router.put(
    "",
    operation_id="updatePaymentSettings",
    summary="Save payment settings (payment details need a recent password confirmation)",
    responses=_REAUTH_RESPONSE,
)
def update_payment_settings(
    body: PaymentSettingsIn,
    user: Annotated[AuthenticatedUser, Depends(require_user)],
    ctx: Ctx,
    app_settings: AppSettings,
) -> PaymentSettingsOut:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
        fields = service.changed_fields(row, body)
        sensitive = any(f in service.SENSITIVE_FIELDS for f in fields)
        if sensitive:
            ensure_recent_auth(user, app_settings)
        service.validate_consistency(body, has_qr=bool(row and row["qr_code_storage_key"]))
        if fields:
            settings_id = service.upsert(db, ctx.employer_id, body)
            service.write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=settings_id,
                fields=fields,
                reauthenticated=sensitive,
            )
        return service.to_out(db, service.load_row(db))


@router.put(
    "/qr",
    operation_id="uploadPaymentQr",
    summary="Upload or replace the QR image (PNG/JPG, max 2 MB, at least 300×300)",
    responses=_REAUTH_RESPONSE,
)
def upload_payment_qr(
    file: UploadFile,
    user: RecentAuthUser,
    ctx: Ctx,
    storage: Storage,
    app_settings: AppSettings,
) -> PaymentSettingsOut:
    raw = file.file.read(service.QR_MAX_BYTES + 1)
    png = service.process_qr(raw)
    key = f"{ctx.employer_id}/qr/{uuid.uuid4()}.png"
    storage.put(app_settings.qr_bucket, key, png, "image/png")
    old_key: str | None = None
    try:
        with tenant_session(ctx.employer_id) as db:
            row = service.load_row(db)
            old_key = row["qr_code_storage_key"] if row else None
            settings_id = db.execute(
                text(
                    "INSERT INTO payment_settings (employer_id, qr_code_storage_key) "
                    "VALUES (:e, :k) ON CONFLICT (employer_id) DO UPDATE "
                    "SET qr_code_storage_key = EXCLUDED.qr_code_storage_key, updated_at = now() "
                    "RETURNING id"
                ),
                {"e": ctx.employer_id, "k": key},
            ).scalar_one()
            service.write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=uuid.UUID(str(settings_id)),
                fields=["qr_code"],
                reauthenticated=True,
            )
            out = service.to_out(db, service.load_row(db))
    except Exception:
        storage.delete(app_settings.qr_bucket, key)
        raise
    if old_key:
        _best_effort_delete(storage, app_settings.qr_bucket, old_key)
    return out


@router.delete(
    "/qr",
    operation_id="deletePaymentQr",
    summary="Remove the QR image (turn the QR method off first)",
    responses=_REAUTH_RESPONSE,
)
def delete_payment_qr(
    user: RecentAuthUser, ctx: Ctx, storage: Storage, app_settings: AppSettings
) -> PaymentSettingsOut:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
        old_key = row["qr_code_storage_key"] if row else None
        if row and old_key:
            if row["qr_enabled"]:
                raise service.unprocessable("qr_enabled", "Turn off the QR code before removing it")
            db.execute(
                text("UPDATE payment_settings SET qr_code_storage_key = NULL, updated_at = now()")
            )
            service.write_audit(
                db,
                employer_id=ctx.employer_id,
                actor=_actor(user),
                actor_id=user.auth_user_id,
                entity_id=uuid.UUID(str(row["id"])),
                fields=["qr_code"],
                reauthenticated=True,
            )
        out = service.to_out(db, service.load_row(db))
    if old_key:
        _best_effort_delete(storage, app_settings.qr_bucket, old_key)
    return out


@router.get(
    "/qr",
    operation_id="getPaymentQr",
    summary="The employer's own QR image (authenticated; never public)",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}, 404: {"description": "No QR image"}},
)
def get_payment_qr(ctx: Ctx, storage: Storage, app_settings: AppSettings) -> Response:
    with tenant_session(ctx.employer_id) as db:
        row = service.load_row(db)
    key = row["qr_code_storage_key"] if row else None
    # Defence in depth: the key must live under this employer's own prefix.
    if not key or not key.startswith(f"{ctx.employer_id}/"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No QR image")
    data = storage.get(app_settings.qr_bucket, key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No QR image")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


def _best_effort_delete(storage: StorageService, bucket: str, key: str) -> None:
    import logging

    try:
        storage.delete(bucket, key)
    except Exception:  # an orphaned private object is harmless; never fail the request for it
        logging.getLogger(__name__).warning("could not delete replaced QR object")
