from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import uuid
from pathlib import Path

import pytest
from alembic import command
from pydantic import ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app import worker
from app.core import crypto
from app.core.config import Settings
from app.core.logging import JsonFormatter, redact
from tests.conftest import alembic_config

KEY = base64.b64encode(os.urandom(32)).decode()
HMAC = secrets.token_hex(32)
BASE = {
    "database_url": "postgresql://u:p@localhost/db",
    "token_enc_key": KEY,
    "token_hmac_secret": HMAC,
}


def settings(**over: object) -> Settings:
    return Settings(_env_file=None, **{**BASE, **over})  # type: ignore[arg-type]


# ----------------------------------------------------------------- crypto (ADR 0001)
def test_token_roundtrip_hash_and_randomness() -> None:
    t1, t2 = crypto.generate_token(), crypto.generate_token()
    assert t1 != t2 and len(t1) >= 43
    blob = crypto.encrypt_token(t1, KEY)
    assert t1.encode() not in blob
    assert crypto.decrypt_token(blob, KEY) == t1
    assert crypto.encrypt_token(t1, KEY) != blob  # fresh nonce each time
    assert crypto.hash_token(t1, HMAC) == crypto.hash_token(t1, HMAC)
    assert crypto.hash_token(t1, HMAC) != crypto.hash_token(t2, HMAC)
    assert crypto.hash_token(t1, HMAC) != crypto.hash_token(t1, "y" * 32)


def test_tampered_or_wrong_key_ciphertext_is_rejected() -> None:
    blob = bytearray(crypto.encrypt_token("abc", KEY))
    blob[-1] ^= 1
    with pytest.raises(Exception, match=r".*"):
        crypto.decrypt_token(bytes(blob), KEY)
    other = base64.b64encode(os.urandom(32)).decode()
    with pytest.raises(Exception, match=r".*"):
        crypto.decrypt_token(crypto.encrypt_token("abc", KEY), other)


# ----------------------------------------------------------------- config
def test_settings_normalise_database_url() -> None:
    assert settings().database_url.startswith("postgresql+psycopg://")


@pytest.mark.parametrize(
    "over",
    [
        {"token_enc_key": base64.b64encode(b"short").decode()},
        {"token_enc_key": "not base64!!"},
        {"token_hmac_secret": "too-short"},
        {"cors_origins": "*"},
        {"app_env": "production", "supabase_jwt_secret": None, "supabase_jwks_url": None},
        {"ai_enabled": True},  # needs key + cost cap
    ],
)
def test_settings_reject_unsafe_configuration(over: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        settings(**over)


def test_ai_is_off_by_default_and_capped_when_enabled() -> None:
    assert settings().ai_enabled is False
    s = settings(ai_enabled=True, anthropic_api_key="sk-test", ai_monthly_cost_cap_usd=5)
    assert s.ai_monthly_cost_cap_usd == 5


def test_frozen_retention_defaults() -> None:
    s = settings()
    assert (s.import_retention_days, s.failed_import_retention_days) == (90, 7)


# ----------------------------------------------------------------- logging redaction
def test_logs_never_contain_jwts_bearers_or_tokens() -> None:
    jwt_like = ".".join(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijk"])
    assert jwt_like not in redact(f"auth failed for {jwt_like}")
    assert "abc123" not in redact("Authorization: Bearer abc123.def")
    assert "s3cr3t" not in redact("GET /x?token=s3cr3t&a=1")
    rec = logging.LogRecord("t", logging.INFO, "f", 1, "token=%s", ("zzz",), None)
    assert "zzz" not in json.loads(JsonFormatter().format(rec))["msg"]


# ----------------------------------------------------------------- worker + migrations
def test_worker_starts_and_stops_cleanly() -> None:
    worker.run(once=True, interval_seconds=0.01)


def test_migration_roundtrip_on_a_fresh_database(admin_engine: object) -> None:
    from sqlalchemy import Engine

    assert isinstance(admin_engine, Engine)
    name = f"mig_{uuid.uuid4().hex[:10]}"
    with admin_engine.connect() as c:
        c.execute(text(f"CREATE DATABASE {name}"))
    try:
        url = make_url(admin_engine.url.render_as_string(hide_password=False)).set(database=name)
        url_s = url.render_as_string(hide_password=False)
        cfg = alembic_config(url_s)
        command.upgrade(cfg, "head")
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")
        with create_engine(url_s).connect() as c2:
            n = c2.execute(
                text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
            ).scalar_one()
            assert n >= 11
    finally:
        with admin_engine.connect() as c:
            c.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))


def test_env_example_contains_no_real_secrets() -> None:
    text_ = (Path(__file__).resolve().parent.parent / ".env.example").read_text()
    for line in text_.splitlines():
        if line.startswith(
            (
                "TOKEN_ENC_KEY=",
                "TOKEN_HMAC_SECRET=",
                "ANTHROPIC_API_KEY=",
                "SUPABASE_SERVICE_ROLE_KEY=",
                "SUPABASE_JWT_SECRET=",
            )
        ):
            value = line.split("=", 1)[1].split("#", 1)[0].strip()  # ignore inline comments
            assert value == ""  # must be blank placeholders
