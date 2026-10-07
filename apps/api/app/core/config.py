"""Backend settings. Every secret lives here and is read from the environment only.

Nothing in this module is ever sent to the frontend. See apps/api/.env.example.
"""

from __future__ import annotations

import base64
import binascii
from functools import lru_cache
from typing import Literal, Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["local", "test", "staging", "production"] = "local"

    # Database (Postgres / Supabase). Accepts postgresql:// or postgresql+psycopg://.
    database_url: str

    # Browser origins allowed to call the API (comma separated, never "*").
    cors_origins: str = "http://localhost:5173"

    # Supabase Auth JWT verification. Provide JWKS URL (asymmetric keys) OR the HS256 secret.
    supabase_jwks_url: str | None = None
    supabase_jwt_secret: str | None = None
    jwt_audience: str = "authenticated"
    jwt_issuer: str | None = None

    # Supabase project (backend-only). The service-role key must never reach the browser.
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None

    # Re-authentication window for sensitive changes (see docs/adr/0004-reauthentication.md).
    reauth_max_age_seconds: int = 300

    # Private object storage for QR images. "local" is for development/tests only.
    storage_backend: Literal["local", "supabase"] = "local"
    local_storage_dir: str = ".local-storage"
    qr_bucket: str = "qr"

    # Payment-token crypto (docs/adr/0001). Backend-only.
    token_enc_key: str  # base64, 32 bytes (AES-256-GCM)
    token_enc_key_id: str = "k1"  # noqa: S105 (key label, not a secret)
    token_hmac_secret: str  # >= 32 chars

    # AI fallback: off by default, cost-capped, backend-only key.
    ai_enabled: bool = False
    anthropic_api_key: str | None = None
    ai_monthly_cost_cap_usd: float = 0.0

    # Scanned-PDF text recognition (Tesseract, installed in the Docker image). Runs inside the
    # request: hard page/time limits, no background workers.
    ocr_enabled: bool = True
    ocr_languages: str = "eng"
    pdf_max_pages: int = 10
    pdf_timeout_seconds: int = 60

    # Google Sheets import. Public sheets need nothing. Private sheets use ONE service account
    # that the employer shares the sheet with (Viewer). The private key is backend-only.
    google_service_account_email: str | None = None
    google_service_account_private_key: str | None = None
    # Google's own endpoints. Only these configured origins are ever contacted (SSRF guard).
    google_docs_base_url: str = "https://docs.google.com"
    google_sheets_api_base_url: str = "https://sheets.googleapis.com"
    google_token_url: str = "https://oauth2.googleapis.com/token"  # noqa: S105 (a URL, not a secret)

    # Retention (frozen product defaults).
    import_retention_days: int = 90
    failed_import_retention_days: int = 7

    @field_validator("database_url")
    @classmethod
    def _normalise_db_url(cls, v: str) -> str:
        if v.startswith("postgres://"):
            v = "postgresql://" + v.removeprefix("postgres://")
        if v.startswith("postgresql://"):
            v = "postgresql+psycopg://" + v.removeprefix("postgresql://")
        return v

    @field_validator("token_enc_key")
    @classmethod
    def _check_enc_key(cls, v: str) -> str:
        try:
            raw = base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("TOKEN_ENC_KEY must be base64") from exc
        if len(raw) != 32:
            raise ValueError("TOKEN_ENC_KEY must decode to exactly 32 bytes")
        return v

    @field_validator("token_hmac_secret")
    @classmethod
    def _check_hmac_secret(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("TOKEN_HMAC_SECRET must be at least 32 characters")
        return v

    @model_validator(mode="after")
    def _check_consistency(self) -> Self:
        if "*" in self.cors_origins:
            raise ValueError("CORS_ORIGINS must list explicit origins, never '*'")
        if self.app_env in ("staging", "production") and not (
            self.supabase_jwks_url or self.supabase_jwt_secret
        ):
            raise ValueError("Set SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET")
        if self.app_env in ("staging", "production") and self.storage_backend != "supabase":
            raise ValueError("STORAGE_BACKEND must be 'supabase' in staging/production")
        if self.storage_backend == "supabase" and not (
            self.supabase_url and self.supabase_service_role_key
        ):
            raise ValueError("STORAGE_BACKEND=supabase requires SUPABASE_URL and the service key")
        if bool(self.google_service_account_email) != bool(self.google_service_account_private_key):
            raise ValueError(
                "Set BOTH GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, "
                "or neither"
            )
        if self.ai_enabled and (not self.anthropic_api_key or self.ai_monthly_cost_cap_usd <= 0):
            raise ValueError(
                "AI_ENABLED requires ANTHROPIC_API_KEY and AI_MONTHLY_COST_CAP_USD > 0"
            )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # values come from the environment
