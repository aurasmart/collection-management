from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app import provisioning
from app.core.config import get_settings
from app.provisioning import (
    ProvisioningError,
    SupabaseAuthAdmin,
    provision_employer,
)
from tests.conftest import bearer

PASSWORD = "correct-horse-battery"


class FakeAdmin:
    def __init__(self, user_id: uuid.UUID | None = None) -> None:
        self.user_id = user_id or uuid.uuid4()
        self.created: list[tuple[str, str]] = []
        self.deleted: list[uuid.UUID] = []

    def create_user(self, email: str, password: str) -> uuid.UUID:
        self.created.append((email, password))
        return self.user_id

    def delete_user(self, user_id: uuid.UUID) -> None:
        self.deleted.append(user_id)


def db_url() -> str:
    return get_settings().database_url


def test_creates_auth_user_employer_and_audit_event(admin_engine: Engine) -> None:
    admin = FakeAdmin()
    res = provision_employer(
        db_url(), admin, name="Acme Traders", email=" Owner@Acme.Example ", password=PASSWORD
    )
    assert res.created_auth_user and res.auth_user_id == admin.user_id
    assert admin.created == [("owner@acme.example", PASSWORD)]
    with admin_engine.connect() as c:
        row = c.execute(
            text("SELECT auth_user_id, name, email FROM employers WHERE id = :i"),
            {"i": res.employer_id},
        ).one()
        audit = c.execute(
            text("SELECT actor, action, details FROM audit_events WHERE employer_id = :i"),
            {"i": res.employer_id},
        ).one()
    assert (row.auth_user_id, row.name, row.email) == (
        admin.user_id,
        "Acme Traders",
        "owner@acme.example",
    )
    assert (audit.actor, audit.action, audit.details) == (
        "operator",
        "employer_provisioned",
        {"method": "created"},
    )
    assert PASSWORD not in json.dumps(audit.details)


def test_provisioned_employer_can_use_the_api(client: TestClient) -> None:
    admin = FakeAdmin()
    provision_employer(db_url(), admin, name="Acme", email="o@acme.example", password=PASSWORD)
    r = client.get("/api/v1/me", headers=bearer(admin.user_id))
    assert r.status_code == 200 and r.json()["employer"]["email"] == "o@acme.example"


def test_links_an_existing_auth_user_without_touching_supabase(admin_engine: Engine) -> None:
    existing = uuid.uuid4()
    res = provision_employer(
        db_url(), None, name="Linked Co", email="l@linked.example", auth_user_id=existing
    )
    assert not res.created_auth_user and res.auth_user_id == existing


@pytest.mark.parametrize(
    "kwargs",
    [
        {"name": "A", "email": "a@b.example", "password": PASSWORD},
        {"name": "Acme", "email": "not-an-email", "password": PASSWORD},
        {"name": "Acme", "email": "a@b.example", "password": "short"},
        {"name": "Acme", "email": "a@b.example", "password": None},
    ],
)
def test_input_is_validated_before_anything_is_created(kwargs: dict[str, Any]) -> None:
    admin = FakeAdmin()
    with pytest.raises(ProvisioningError):
        provision_employer(db_url(), admin, **kwargs)
    assert admin.created == []


def test_requires_admin_access_when_creating_a_login() -> None:
    with pytest.raises(ProvisioningError, match="SUPABASE_URL"):
        provision_employer(db_url(), None, name="Acme", email="a@b.example", password=PASSWORD)


def test_refuses_duplicates_without_creating_a_second_login(make_tenant: Any) -> None:
    t = make_tenant("dup")
    admin = FakeAdmin()
    with pytest.raises(ProvisioningError, match="already exists"):
        provision_employer(
            db_url(), admin, name="Other", email="DUP@example.test", password=PASSWORD
        )
    with pytest.raises(ProvisioningError, match="already exists"):
        provision_employer(
            db_url(), None, name="Other", email="x@y.example", auth_user_id=t.auth_user_id
        )
    assert admin.created == []


def test_database_failure_removes_the_freshly_created_login(make_tenant: Any) -> None:
    t = make_tenant("taken")
    admin = FakeAdmin(
        user_id=t.auth_user_id
    )  # collides with the UNIQUE auth_user_id after the pre-check
    with pytest.raises(Exception, match=r".*"):  # noqa: B017 - DB integrity error surfaces unchanged
        provision_employer(
            db_url(), admin, name="Acme", email="new@acme.example", password=PASSWORD
        )
    assert admin.deleted == [t.auth_user_id]


def test_supabase_admin_api_calls_use_the_service_key_only_server_side() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json={"id": "5f0c3a52-3f5b-4a0e-9b44-0d5d4a1ad001"})

    admin = SupabaseAuthAdmin(
        "https://p.supabase.co",
        "svc-key",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    uid = admin.create_user("a@b.example", PASSWORD)
    admin.delete_user(uid)
    create, delete = seen
    assert str(create.url) == "https://p.supabase.co/auth/v1/admin/users"
    assert json.loads(create.content) == {
        "email": "a@b.example",
        "password": PASSWORD,
        "email_confirm": True,
    }
    assert create.headers["authorization"] == "Bearer svc-key"
    assert delete.method == "DELETE" and str(delete.url).endswith(f"/admin/users/{uid}")


def test_supabase_admin_maps_existing_user_error() -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(422, json={"error_code": "email_exists", "msg": "exists"})
        )
    )
    with pytest.raises(ProvisioningError, match="--auth-user-id"):
        SupabaseAuthAdmin("https://p.supabase.co", "k", client=client).create_user(
            "a@b.example", PASSWORD
        )


def test_cli_link_mode_prints_ids_and_never_a_password(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PROVISION_PASSWORD", raising=False)
    existing = uuid.uuid4()
    code = provisioning.main(
        ["create", "--name", "Cli Co", "--email", "cli@co.example", "--auth-user-id", str(existing)]
    )
    out = capsys.readouterr()
    assert code == 0 and str(existing) in out.out and "employer_id" in out.out
    assert "password" not in (out.out + out.err).lower()


def test_cli_reports_operator_errors_with_exit_code_1(capsys: pytest.CaptureFixture[str]) -> None:
    code = provisioning.main(
        ["create", "--name", "X", "--email", "bad", "--auth-user-id", str(uuid.uuid4())]
    )
    assert code == 1 and "error:" in capsys.readouterr().err
