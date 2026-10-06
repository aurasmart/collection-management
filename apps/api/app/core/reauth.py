"""Re-authentication gate for sensitive changes (docs/adr/0004-reauthentication.md).

The browser re-authenticates with Supabase (`signInWithPassword`), which stamps a fresh `amr`
password timestamp into the new access token. The API only checks that timestamp: the password
never passes through our API or logs. Missing or stale timestamp => 403 `reauth_required`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, status

from app.core.config import Settings, get_settings
from app.core.security import AuthenticatedUser, require_user

REAUTH_REQUIRED = "reauth_required"


def ensure_recent_auth(user: AuthenticatedUser, settings: Settings) -> None:
    """Raise 403 `reauth_required` unless the user authenticated with a password recently."""
    last = user.last_password_auth_at
    if last is None or (datetime.now(UTC) - last).total_seconds() > settings.reauth_max_age_seconds:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": REAUTH_REQUIRED,
                "message": "Please confirm your password to continue.",
            },
        )


def require_recent_auth(
    user: Annotated[AuthenticatedUser, Depends(require_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AuthenticatedUser:
    ensure_recent_auth(user, settings)
    return user


RecentAuthUser = Annotated[AuthenticatedUser, Depends(require_recent_auth)]
