"""Operator employer-provisioning (docs/adr/0003 A6). There is NO public signup.

    uv run python -m app.provisioning create --name "Acme Traders" --email owner@acme.example
    uv run python -m app.provisioning create --name "Acme Traders" --email owner@acme.example \\
        --auth-user-id <existing Supabase auth user id>      # link instead of creating

Creates the Supabase Auth user (admin API, backend-only service key) and the linked `employers`
row. Safe to re-run: it refuses duplicates, and removes a freshly created auth user if the
database step fails. The password is prompted (never a CLI argument) and never printed or logged.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
import uuid
from dataclasses import dataclass
from typing import Protocol

import httpx
from sqlalchemy import create_engine, text

from app.core.config import get_settings

MIN_PASSWORD_LENGTH = 12
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ProvisioningError(Exception):
    """A problem the operator can fix; the message is safe to print."""


class AuthAdmin(Protocol):
    def create_user(self, email: str, password: str) -> uuid.UUID: ...

    def delete_user(self, user_id: uuid.UUID) -> None: ...


class SupabaseAuthAdmin:
    """Supabase Auth admin API. Uses the service-role key: backend/operator machine only."""

    def __init__(
        self, base_url: str, service_key: str, *, client: httpx.Client | None = None
    ) -> None:
        self._base = base_url.rstrip("/") + "/auth/v1/admin/users"
        self._headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
        self._client = client or httpx.Client(timeout=15.0)

    def create_user(self, email: str, password: str) -> uuid.UUID:
        resp = self._client.post(
            self._base,
            headers=self._headers,
            json={"email": email, "password": password, "email_confirm": True},
        )
        if resp.status_code in (409, 422) and "exists" in resp.text.lower():
            raise ProvisioningError(
                "A Supabase Auth user with this email already exists. "
                "Re-run with --auth-user-id <id> to link it."
            )
        if resp.status_code >= 300:
            raise ProvisioningError(
                f"Supabase Auth refused to create the user ({resp.status_code})"
            )
        return uuid.UUID(resp.json()["id"])

    def delete_user(self, user_id: uuid.UUID) -> None:
        self._client.delete(f"{self._base}/{user_id}", headers=self._headers)


@dataclass(frozen=True)
class Provisioned:
    employer_id: uuid.UUID
    auth_user_id: uuid.UUID
    created_auth_user: bool


def provision_employer(
    database_url: str,
    admin: AuthAdmin | None,
    *,
    name: str,
    email: str,
    phone: str | None = None,
    password: str | None = None,
    auth_user_id: uuid.UUID | None = None,
) -> Provisioned:
    name = name.strip()
    email = email.strip().lower()
    if not 2 <= len(name) <= 120:
        raise ProvisioningError("Name must be 2 to 120 characters.")
    if not _EMAIL_RE.match(email):
        raise ProvisioningError("Enter a valid email address.")
    if auth_user_id is None:
        if admin is None:
            raise ProvisioningError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        if not password or len(password) < MIN_PASSWORD_LENGTH:
            raise ProvisioningError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")

    engine = create_engine(database_url)
    try:
        with engine.connect() as conn:
            clash = conn.execute(
                text("SELECT 1 FROM employers WHERE lower(email) = :e OR auth_user_id = :a"),
                {"e": email, "a": auth_user_id},
            ).first()
            if clash:
                raise ProvisioningError("An employer with this email or auth user already exists.")

        created = auth_user_id is None
        if created:
            assert admin is not None and password is not None  # noqa: S101 (validated above)
            auth_user_id = admin.create_user(email, password)
        assert auth_user_id is not None  # noqa: S101
        try:
            with engine.begin() as conn:
                employer_id = conn.execute(
                    text(
                        "INSERT INTO employers (auth_user_id, name, email, phone) "
                        "VALUES (:a, :n, :e, :p) RETURNING id"
                    ),
                    {"a": auth_user_id, "n": name, "e": email, "p": phone},
                ).scalar_one()
                conn.execute(
                    text(
                        "INSERT INTO audit_events (employer_id, actor, entity_type, entity_id, "
                        "action, details) VALUES (:e, 'operator', 'employer', :e, "
                        "'employer_provisioned', CAST(:d AS jsonb))"
                    ),
                    {
                        "e": employer_id,
                        "d": '{"method": "%s"}' % ("created" if created else "linked"),
                    },
                )
        except Exception:
            if created and admin is not None:
                admin.delete_user(auth_user_id)  # do not leave an orphaned login behind
            raise
        return Provisioned(uuid.UUID(str(employer_id)), auth_user_id, created)
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.provisioning", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="create an employer and its login")
    create.add_argument("--name", required=True)
    create.add_argument("--email", required=True)
    create.add_argument("--phone")
    create.add_argument(
        "--auth-user-id", type=uuid.UUID, help="link an existing Supabase auth user"
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    admin: AuthAdmin | None = None
    if settings.supabase_url and settings.supabase_service_role_key:
        admin = SupabaseAuthAdmin(settings.supabase_url, settings.supabase_service_role_key)

    password: str | None = None
    if args.auth_user_id is None:
        password = os.environ.get("PROVISION_PASSWORD") or getpass.getpass("Initial password: ")
        if (
            not os.environ.get("PROVISION_PASSWORD")
            and getpass.getpass("Repeat password: ") != password
        ):
            print("Passwords do not match.", file=sys.stderr)
            return 2
    try:
        result = provision_employer(
            settings.database_url,
            admin,
            name=args.name,
            email=args.email,
            phone=args.phone,
            password=password,
            auth_user_id=args.auth_user_id,
        )
    except ProvisioningError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"employer_id   {result.employer_id}")
    how = "created" if result.created_auth_user else "linked"
    print(f"auth_user_id  {result.auth_user_id} ({how})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
