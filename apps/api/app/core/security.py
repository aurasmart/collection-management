"""Supabase JWT verification (Authorization: Bearer <access token>).

Algorithms are pinned per key type; `none` and algorithm confusion are rejected.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from app.core.config import Settings, get_settings

_bearer = HTTPBearer(auto_error=False)
_ASYMMETRIC_ALGS = ["ES256", "RS256"]
_SYMMETRIC_ALGS = ["HS256"]


@dataclass(frozen=True)
class AuthenticatedUser:
    auth_user_id: uuid.UUID
    email: str | None


def _unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


@lru_cache
def _jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(url, cache_keys=True)


def decode_token(token: str, settings: Settings) -> dict[str, Any]:
    options = {"require": ["exp", "sub"]}
    kwargs: dict[str, Any] = {"audience": settings.jwt_audience, "options": options}
    if settings.jwt_issuer:
        kwargs["issuer"] = settings.jwt_issuer
    if settings.supabase_jwks_url:
        signing_key = _jwks_client(settings.supabase_jwks_url).get_signing_key_from_jwt(token).key
        return jwt.decode(token, signing_key, algorithms=_ASYMMETRIC_ALGS, **kwargs)
    if settings.supabase_jwt_secret:
        return jwt.decode(token, settings.supabase_jwt_secret, algorithms=_SYMMETRIC_ALGS, **kwargs)
    raise jwt.InvalidTokenError("no verification key configured")


def require_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AuthenticatedUser:
    if credentials is None:
        raise _unauthorized()
    try:
        claims = decode_token(credentials.credentials, settings)
        user_id = uuid.UUID(str(claims["sub"]))
    except (jwt.PyJWTError, ValueError, KeyError) as exc:
        raise _unauthorized("Invalid or expired session") from exc
    email = claims.get("email")
    return AuthenticatedUser(auth_user_id=user_id, email=email if isinstance(email, str) else None)
