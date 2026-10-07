"""Company profile logic. Runs inside a tenant session (RLS); `employer_id` always comes from the
verified session, never from the request."""

from __future__ import annotations

import io
import uuid
from typing import Any

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.modules.company.schemas import (
    EDITABLE_FIELDS,
    CompanyChange,
    CompanyProfileIn,
    CompanyProfileOut,
)
from app.modules.settings.service import unprocessable

LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_MIN_SIDE = 64
LOGO_MAX_SIDE = 4096
LOGO_OUTPUT_SIDE = 512  # stored size: plenty for a header image, small for every phone
_ALLOWED = {"PNG", "JPEG", "WEBP"}
Image.MAX_IMAGE_PIXELS = LOGO_MAX_SIDE * LOGO_MAX_SIDE

_COLUMNS = ", ".join(("id", "logo_key", "updated_at", *EDITABLE_FIELDS))


def load_row(db: Session) -> dict[str, Any] | None:
    row = db.execute(text(f"SELECT {_COLUMNS} FROM company_profiles")).mappings().one_or_none()  # noqa: S608
    return dict(row) if row else None


def employer_name(db: Session) -> str:
    return str(db.execute(text("SELECT name FROM employers")).scalar_one())


def changed_fields(
    current: dict[str, Any] | None, new: CompanyProfileIn, fallback: str
) -> list[str]:
    incoming = new.model_dump()
    if current is None:
        # Nothing saved yet: only what differs from the pre-filled form counts as a change.
        return [
            f for f in EDITABLE_FIELDS if incoming[f] != (fallback if f == "display_name" else None)
        ] or ["display_name"]
    return [f for f in EDITABLE_FIELDS if incoming[f] != current[f]]


def recent_changes(db: Session) -> list[CompanyChange]:
    rows = db.execute(
        text(
            "SELECT created_at, actor, details FROM audit_events "
            "WHERE entity_type = 'company_profile' ORDER BY created_at DESC, id DESC LIMIT 5"
        )
    ).all()
    return [
        CompanyChange(at=r.created_at, actor=r.actor, fields=list(r.details.get("fields", [])))
        for r in rows
    ]


def to_out(db: Session, row: dict[str, Any] | None) -> CompanyProfileOut:
    data = {f: (row[f] if row else None) for f in EDITABLE_FIELDS}
    if row is None:
        data["display_name"] = employer_name(db)  # pre-filled until the employer saves
    return CompanyProfileOut(
        **data,
        has_logo=bool(row and row["logo_key"]),
        saved=row is not None,
        updated_at=row["updated_at"] if row else None,
        recent_changes=recent_changes(db),
    )


def upsert(db: Session, employer_id: uuid.UUID, new: CompanyProfileIn) -> uuid.UUID:
    cols = ", ".join(EDITABLE_FIELDS)
    params = ", ".join(f":{f}" for f in EDITABLE_FIELDS)
    sets = ", ".join(f"{f} = EXCLUDED.{f}" for f in EDITABLE_FIELDS)
    row = db.execute(
        text(
            f"INSERT INTO company_profiles (employer_id, {cols}) VALUES (:employer_id, {params}) "  # noqa: S608
            f"ON CONFLICT (employer_id) DO UPDATE SET {sets} RETURNING id"
        ),
        {"employer_id": employer_id, **new.model_dump()},
    ).one()
    return uuid.UUID(str(row.id))


def ensure_row(db: Session, employer_id: uuid.UUID) -> None:
    """A logo can be uploaded before the form was ever saved: start from the account name."""
    db.execute(
        text(
            "INSERT INTO company_profiles (employer_id, display_name) "
            "SELECT id, CASE WHEN char_length(btrim(name)) >= 2 THEN left(btrim(name), 60) "
            "ELSE 'My company' END FROM employers WHERE id = :e "
            "ON CONFLICT (employer_id) DO NOTHING"
        ),
        {"e": employer_id},
    )


def process_logo(data: bytes) -> bytes:
    """Validate an uploaded logo; re-encode it as a clean, downsized PNG (never trust the file)."""
    if not data:
        raise unprocessable("logo", "This file is empty")
    if len(data) > LOGO_MAX_BYTES:
        raise unprocessable("logo", "This image is larger than 2 MB")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format
            width, height = img.size
            if fmt not in _ALLOWED:
                raise unprocessable("logo", "Upload a PNG, JPG or WebP image")
            if getattr(img, "n_frames", 1) > 1:
                raise unprocessable("logo", "Animated images are not supported")
            if width < LOGO_MIN_SIDE or height < LOGO_MIN_SIDE:
                raise unprocessable("logo", "This image is too small. Use at least 64 × 64 pixels")
            if width > LOGO_MAX_SIDE or height > LOGO_MAX_SIDE:
                raise unprocessable(
                    "logo", "This image is too large. Use at most 4096 × 4096 pixels"
                )
            img.load()
            has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
            clean = img.convert("RGBA" if has_alpha else "RGB")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, ValueError):
        raise unprocessable(
            "logo", "This image isn't a supported format or is unreadable"
        ) from None
    clean.thumbnail((LOGO_OUTPUT_SIDE, LOGO_OUTPUT_SIDE))
    out = io.BytesIO()
    clean.save(out, format="PNG", optimize=True)
    return out.getvalue()
