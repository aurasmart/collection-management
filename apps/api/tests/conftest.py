"""Test harness.

Requires a Postgres reachable at TEST_DATABASE_URL (a superuser/owner role, e.g. the one
started by `docker compose up db`, or the service container in CI). Nothing is skipped
silently: without it the suite fails with an explanation.
"""

from __future__ import annotations

import atexit
import base64
import os
import secrets
import shutil
import tempfile
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text

API_ROOT = Path(__file__).resolve().parent.parent
JWT_SECRET = "test-only-jwt-secret-" + secrets.token_hex(40)

_TEST_DB = os.environ.get("TEST_DATABASE_URL")
if not _TEST_DB:
    pytest.exit(
        "TEST_DATABASE_URL is not set. Start Postgres (`make db-up`) and export "
        "TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres",
        returncode=2,
    )

_STORAGE_DIR = tempfile.mkdtemp(prefix="qr-test-")
atexit.register(shutil.rmtree, _STORAGE_DIR, ignore_errors=True)

# Must be set before any `app.*` import reads settings.
os.environ.update(
    {
        "STORAGE_BACKEND": "local",
        "LOCAL_STORAGE_DIR": _STORAGE_DIR,
        "REAUTH_MAX_AGE_SECONDS": "300",
        "APP_ENV": "test",
        "DATABASE_URL": _TEST_DB,
        "SUPABASE_JWT_SECRET": JWT_SECRET,
        "TOKEN_ENC_KEY": base64.b64encode(os.urandom(32)).decode(),
        "TOKEN_HMAC_SECRET": secrets.token_hex(32),
        "CORS_ORIGINS": "http://localhost:5173",
    }
)

from app.core.config import get_settings  # noqa: E402
from app.core.db import get_engine  # noqa: E402
from app.main import create_app  # noqa: E402

TENANT_TABLES = [
    "customers",
    "import_batches",
    "import_rows",
    "collections",
    "payment_requests",
    "payments",
    "payment_settings",
    "notifications",
    "audit_events",
]


def alembic_config(url: str) -> Config:
    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


@pytest.fixture(scope="session", autouse=True)
def migrated() -> Iterator[None]:
    command.upgrade(alembic_config(get_settings().database_url), "head")
    yield
    get_engine().dispose()


@pytest.fixture(scope="session")
def admin_engine() -> Iterator[Engine]:
    engine = create_engine(get_settings().database_url, isolation_level="AUTOCOMMIT")
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean_db(admin_engine: Engine) -> Iterator[None]:
    yield
    with admin_engine.connect() as conn:
        conn.execute(text("TRUNCATE employers CASCADE"))


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> None:
    from app.core.ratelimit import public_miss_limiter, public_page_limiter

    public_page_limiter.reset()
    public_miss_limiter.reset()


class Tenant:
    def __init__(self, employer_id: uuid.UUID, auth_user_id: uuid.UUID, ids: dict[str, uuid.UUID]):
        self.employer_id = employer_id
        self.auth_user_id = auth_user_id
        self.ids = ids


@pytest.fixture
def make_tenant(admin_engine: Engine) -> Callable[[str], Tenant]:
    """Seed one row in every tenant table, as the table owner (bypassing RLS)."""

    def _make(label: str) -> Tenant:
        eid, auth = uuid.uuid4(), uuid.uuid4()
        ids = {
            k: uuid.uuid4()
            for k in ("customer", "batch", "collection", "request", "payment", "row", "audit")
        }
        with admin_engine.connect() as c:
            c.execute(
                text(
                    "INSERT INTO employers (id, auth_user_id, name, email) VALUES (:e, :a, :n, :m)"
                ),
                {"e": eid, "a": auth, "n": f"Employer {label}", "m": f"{label}@example.test"},
            )
            c.execute(
                text(
                    "INSERT INTO customers (id, employer_id, name, phone) "
                    "VALUES (:i, :e, 'Cust', :p)"
                ),
                {"i": ids["customer"], "e": eid, "p": f"+9199{uuid.uuid4().int % 10**8:08d}"},
            )
            c.execute(
                text(
                    "INSERT INTO import_batches (id, employer_id, filename, file_type, "
                    "file_hash, uploaded_by) VALUES (:i, :e, 'f.csv', 'CSV', :h, :a)"
                ),
                {"i": ids["batch"], "e": eid, "h": secrets.token_hex(32), "a": auth},
            )
            c.execute(
                text(
                    "INSERT INTO collections (id, employer_id, customer_id, amount_due, "
                    "import_batch_id) VALUES (:i, :e, :c, 10000, :b)"
                ),
                {"i": ids["collection"], "e": eid, "c": ids["customer"], "b": ids["batch"]},
            )
            c.execute(
                text(
                    "INSERT INTO import_rows (id, employer_id, batch_id, row_number) "
                    "VALUES (:i, :e, :b, 1)"
                ),
                {"i": ids["row"], "e": eid, "b": ids["batch"]},
            )
            c.execute(
                text(
                    "INSERT INTO payment_requests (id, employer_id, collection_id, token_hash, "
                    "token_ciphertext, token_key_id, snapshot_customer_name, "
                    "snapshot_amount_requested, snapshot_employer_display_name, "
                    "snapshot_enabled_methods) VALUES (:i, :e, :c, :h, :ct, 'k1', 'Cust', 10000, "
                    "'Acme', '[\"UPI\"]'::jsonb)"
                ),
                {
                    "i": ids["request"],
                    "e": eid,
                    "c": ids["collection"],
                    "h": secrets.token_hex(32),
                    "ct": b"opaque-ciphertext",
                },
            )
            c.execute(
                text(
                    "INSERT INTO payments (id, employer_id, collection_id, amount, "
                    "payment_date, payment_method, created_by) "
                    "VALUES (:i, :e, :c, 100, current_date, 'UPI', :a)"
                ),
                {"i": ids["payment"], "e": eid, "c": ids["collection"], "a": auth},
            )
            c.execute(
                text(
                    "INSERT INTO payment_settings (employer_id, display_name) VALUES (:e, 'Acme')"
                ),
                {"e": eid},
            )
            c.execute(
                text(
                    "INSERT INTO notifications (employer_id, collection_id, channel) "
                    "VALUES (:e, :c, 'MANUAL')"
                ),
                {"e": eid, "c": ids["collection"]},
            )
            c.execute(
                text(
                    "INSERT INTO audit_events (id, employer_id, actor, entity_type, "
                    "action) VALUES (:i, :e, 'test', 'collection', 'seeded')"
                ),
                {"i": ids["audit"], "e": eid},
            )
        return Tenant(eid, auth, ids)

    return _make


def make_jwt(
    sub: uuid.UUID,
    *,
    secret: str = JWT_SECRET,
    algorithm: str = "HS256",
    audience: str = "authenticated",
    expires_in: timedelta = timedelta(hours=1),
    extra: dict[str, Any] | None = None,
    password_auth_age: timedelta | None = None,
) -> str:
    claims: dict[str, Any] = {
        "sub": str(sub),
        "aud": audience,
        "exp": datetime.now(UTC) + expires_in,
        "email": "user@example.test",
        **(extra or {}),
    }
    if password_auth_age is not None:
        # Supabase stamps the sign-in time of each method into the `amr` claim.
        stamp = int((datetime.now(UTC) - password_auth_age).timestamp())
        claims["amr"] = [{"method": "password", "timestamp": stamp}]
    return jwt.encode(claims, secret, algorithm=algorithm)


def bearer(sub: uuid.UUID, **kwargs: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt(sub, **kwargs)}"}


FRESH = timedelta(seconds=5)
STALE = timedelta(minutes=30)


def fresh_auth(sub: uuid.UUID) -> dict[str, str]:
    """A token from a password sign-in a few seconds ago (passes the re-auth gate)."""
    return bearer(sub, password_auth_age=FRESH)


def stale_auth(sub: uuid.UUID) -> dict[str, str]:
    """A valid session whose last password sign-in was long ago (must re-authenticate)."""
    return bearer(sub, password_auth_age=STALE)


@pytest.fixture
def storage_dir() -> Path:
    return Path(_STORAGE_DIR)


@pytest.fixture
def make_employer(admin_engine: Engine) -> Callable[[str], Tenant]:
    """An employer with NO other rows (clean slate for the import/collections tests)."""

    def _make(label: str) -> Tenant:
        eid, auth = uuid.uuid4(), uuid.uuid4()
        with admin_engine.connect() as c:
            c.execute(
                text(
                    "INSERT INTO employers (id, auth_user_id, name, email) VALUES (:e, :a, :n, :m)"
                ),
                {"e": eid, "a": auth, "n": f"Employer {label}", "m": f"{label}@example.test"},
            )
        return Tenant(eid, auth, {})

    return _make
