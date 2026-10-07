"""Payment settings logic. All queries run in a tenant session (RLS) and never take employer_id
from the request; `employer_id` here always comes from the verified session context."""

from __future__ import annotations

import io
import uuid
from typing import Any

from fastapi import HTTPException, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.modules.settings.schemas import PaymentSettingsIn, PaymentSettingsOut, SettingChange

QR_MAX_BYTES = 2 * 1024 * 1024
QR_MIN_SIDE = 300
QR_MAX_SIDE = 4096
Image.MAX_IMAGE_PIXELS = QR_MAX_SIDE * QR_MAX_SIDE

# Every payment-detail change alters what customers are told about paying.
SENSITIVE_FIELDS = (
    "upi_id",
    "upi_number",
    "bank_name",
    "account_name",
    "account_number",
    "ifsc",
    "upi_enabled",
    "upi_number_enabled",
    "qr_enabled",
    "bank_enabled",
)
EDITABLE_FIELDS = SENSITIVE_FIELDS

_EMPTY: dict[str, Any] = {
    "upi_id": None,
    "upi_number": None,
    "bank_name": None,
    "account_name": None,
    "account_number": None,
    "ifsc": None,
    "upi_enabled": False,
    "upi_number_enabled": False,
    "qr_enabled": False,
    "bank_enabled": False,
}


def unprocessable(field: str, message: str) -> HTTPException:
    """422 in FastAPI's own validation shape so the frontend maps every error the same way."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=[{"loc": ["body", field], "msg": message, "type": "value_error"}],
    )


def load_row(db: Session) -> dict[str, Any] | None:
    row = (
        db.execute(
            text(
                "SELECT id, upi_id, upi_number, qr_code_storage_key, bank_name, "
                "account_name, account_number, ifsc, upi_enabled, upi_number_enabled, qr_enabled, "
                "bank_enabled, updated_at FROM payment_settings"
            )
        )
        .mappings()
        .one_or_none()
    )
    return dict(row) if row else None


def recent_changes(db: Session) -> list[SettingChange]:
    rows = db.execute(
        text(
            "SELECT created_at, actor, details FROM audit_events "
            "WHERE entity_type = 'payment_settings' ORDER BY created_at DESC, id DESC LIMIT 5"
        )
    ).all()
    return [
        SettingChange(at=r.created_at, actor=r.actor, fields=list(r.details.get("fields", [])))
        for r in rows
    ]


def to_out(db: Session, row: dict[str, Any] | None) -> PaymentSettingsOut:
    data = {k: (row[k] if row else _EMPTY[k]) for k in EDITABLE_FIELDS}
    return PaymentSettingsOut(
        **data,
        has_qr=bool(row and row["qr_code_storage_key"]),
        updated_at=row["updated_at"] if row else None,
        recent_changes=recent_changes(db),
    )


def changed_fields(current: dict[str, Any] | None, new: PaymentSettingsIn) -> list[str]:
    base = current if current else _EMPTY
    incoming = new.model_dump()
    return [f for f in EDITABLE_FIELDS if incoming[f] != base[f]]


def validate_consistency(new: PaymentSettingsIn, has_qr: bool) -> None:
    """An enabled method must be fully configured (Stage 2 S10: no clearing enabled fields)."""
    if new.upi_enabled and not new.upi_id:
        raise unprocessable("upi_id", "Enter your UPI ID to show it to customers")
    if new.upi_number_enabled and not new.upi_number:
        raise unprocessable("upi_number", "Enter your UPI number to show it to customers")
    if new.qr_enabled and not has_qr:
        raise unprocessable("qr_enabled", "Upload a QR code before turning this on")
    if new.bank_enabled:
        for field, label in (
            ("bank_name", "bank name"),
            ("account_name", "account holder name"),
            ("account_number", "account number"),
            ("ifsc", "IFSC"),
        ):
            if not getattr(new, field):
                raise unprocessable(field, f"Enter the {label} to show bank details")


def write_audit(
    db: Session,
    *,
    employer_id: uuid.UUID,
    actor: str,
    actor_id: uuid.UUID,
    entity_id: uuid.UUID | None,
    fields: list[str],
    reauthenticated: bool,
    entity_type: str = "payment_settings",
) -> None:
    """Field NAMES only: never values, passwords, tokens or keys (Stage 1 §Q, Stage 2 §23)."""
    db.execute(
        text(
            "INSERT INTO audit_events "
            "(employer_id, actor, entity_type, entity_id, action, details) "
            "VALUES (:e, :actor, :etype, :eid, 'settings_changed', CAST(:d AS jsonb))"
        ),
        {
            "e": employer_id,
            "etype": entity_type,
            "actor": actor,
            "eid": entity_id,
            "d": _json(
                {"fields": fields, "actor_id": str(actor_id), "reauthenticated": reauthenticated}
            ),
        },
    )


def _json(obj: dict[str, Any]) -> str:
    import json

    return json.dumps(obj)


def upsert(db: Session, employer_id: uuid.UUID, new: PaymentSettingsIn) -> uuid.UUID:
    values = new.model_dump()
    sets = ", ".join(f"{f} = EXCLUDED.{f}" for f in EDITABLE_FIELDS)
    cols = ", ".join(EDITABLE_FIELDS)
    params = ", ".join(f":{f}" for f in EDITABLE_FIELDS)
    row = db.execute(
        text(
            f"INSERT INTO payment_settings (employer_id, {cols}) VALUES (:employer_id, {params}) "  # noqa: S608
            f"ON CONFLICT (employer_id) DO UPDATE SET {sets}, updated_at = now() RETURNING id"
        ),
        {"employer_id": employer_id, **values},
    ).one()
    return uuid.UUID(str(row.id))


def process_qr(data: bytes) -> bytes:
    """Validate an uploaded QR image and re-encode it as a clean PNG (strips metadata/polyglots)."""
    if not data:
        raise unprocessable("qr", "This file is empty")
    if len(data) > QR_MAX_BYTES:
        raise unprocessable("qr", "This image is larger than 2 MB")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format
            width, height = img.size
            frames = getattr(img, "n_frames", 1)
            if fmt not in ("PNG", "JPEG"):
                raise unprocessable("qr", "Upload a PNG or JPG image")
            if frames > 1:
                raise unprocessable("qr", "Animated images are not supported")
            if width < QR_MIN_SIDE or height < QR_MIN_SIDE:
                raise unprocessable("qr", "This image is too small. Use at least 300 × 300 pixels")
            if width > QR_MAX_SIDE or height > QR_MAX_SIDE:
                raise unprocessable("qr", "This image is too large. Use at most 4096 × 4096 pixels")
            img.load()
            clean = img.convert("RGB") if img.mode not in ("RGB", "L") else img.copy()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, ValueError):
        raise unprocessable("qr", "This image isn't a supported format or is unreadable") from None
    out = io.BytesIO()
    clean.save(out, format="PNG", optimize=True)
    return out.getvalue()
