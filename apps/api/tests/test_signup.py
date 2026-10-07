"""Self sign-up: the workspace is created from the VERIFIED session on first sign-in."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app import provisioning
from app.workspace import WorkspaceError, clean_workspace, workspace_from_identity
from tests.conftest import Tenant, bearer, fresh_auth

SETUP = "/api/v1/account/setup"
META = {"full_name": "Asha Rao", "company_name": "Acme Traders", "phone": "98765 43210"}
MakeTenant = Callable[[str], Tenant]


def signed_up(user: uuid.UUID, email: str = "asha@acme.example", **meta: Any) -> dict[str, str]:
    return bearer(user, extra={"email": email, "user_metadata": {**META, **meta}})


def rows(engine: Engine, sql: str, **p: Any) -> list[Any]:
    with engine.connect() as c:
        return list(c.execute(text(sql), p))


# ------------------------------------------------------------------ the workspace is created
def test_first_sign_in_creates_employer_profile_and_payment_settings(
    client: TestClient, admin_engine: Engine
) -> None:
    user = uuid.uuid4()
    me_before = client.get("/api/v1/me", headers=signed_up(user))
    assert me_before.status_code == 403  # no workspace yet
    r = client.post(SETUP, headers=signed_up(user))
    assert r.status_code == 200 and r.json() == {"created": True}
    emp = rows(
        admin_engine, "SELECT id, name, email, phone FROM employers WHERE auth_user_id = :a", a=user
    )
    assert len(emp) == 1
    assert (emp[0].name, emp[0].email, emp[0].phone) == (
        "Asha Rao",
        "asha@acme.example",
        "+919876543210",
    )
    eid = emp[0].id
    prof = rows(
        admin_engine,
        "SELECT display_name, logo_key, pan FROM company_profiles WHERE employer_id = :e",
        e=eid,
    )
    assert [tuple(x) for x in prof] == [("Acme Traders", None, None)]
    ps = rows(
        admin_engine,
        "SELECT upi_enabled, upi_number_enabled, qr_enabled, bank_enabled FROM payment_settings WHERE employer_id = :e",
        e=eid,
    )
    assert [tuple(x) for x in ps] == [(False, False, False, False)]
    audit = rows(
        admin_engine,
        "SELECT actor, action, details FROM audit_events WHERE employer_id = :e",
        e=eid,
    )
    assert [(a.actor, a.action, a.details) for a in audit] == [
        ("asha@acme.example", "employer_signed_up", {"method": "self_signup"})
    ]
    me = client.get("/api/v1/me", headers=signed_up(user)).json()["employer"]
    assert (me["name"], me["email"]) == (
        "Asha Rao",
        "asha@acme.example",
    )  # account name = full name
    assert (
        client.get("/api/v1/settings/company", headers=signed_up(user)).json()["display_name"]
        == "Acme Traders"
    )


def test_setup_is_idempotent_a_second_call_changes_nothing(
    client: TestClient, admin_engine: Engine
) -> None:
    user = uuid.uuid4()
    client.post(SETUP, headers=signed_up(user))
    again = client.post(
        SETUP, headers=signed_up(user, full_name="Someone Else", company_name="Hijack Co")
    )
    assert again.json() == {"created": False}
    assert [x.name for x in rows(admin_engine, "SELECT name FROM employers")] == ["Asha Rao"]
    assert [
        x.display_name for x in rows(admin_engine, "SELECT display_name FROM company_profiles")
    ] == ["Acme Traders"]
    assert len(rows(admin_engine, "SELECT 1 FROM payment_settings")) == 1


def test_the_new_company_can_use_the_whole_api_immediately(client: TestClient) -> None:
    user = uuid.uuid4()
    h = signed_up(user)
    client.post(SETUP, headers=h)
    assert client.get("/api/v1/collections", headers=h).json()["total"] == 0
    assert client.get("/api/v1/dashboard", headers=h).status_code == 200
    assert client.get("/api/v1/settings/payment", headers=h).status_code == 200
    r = client.put(
        "/api/v1/settings/company",
        json={"display_name": "Acme Wholesale"},
        headers=bearer(
            user,
            extra={"email": "asha@acme.example"},
            password_auth_age=__import__("datetime").timedelta(seconds=5),
        ),
    )
    assert r.status_code == 200 and r.json()["display_name"] == "Acme Wholesale"


def test_missing_sign_up_details_fall_back_to_the_email_so_nobody_is_locked_out(
    client: TestClient, admin_engine: Engine
) -> None:
    user = uuid.uuid4()
    h = bearer(user, extra={"email": "ravi.kumar@shop.example"})  # an account made some other way
    assert client.post(SETUP, headers=h).json() == {"created": True}
    emp = rows(admin_engine, "SELECT name FROM employers")[0]
    prof = rows(admin_engine, "SELECT display_name FROM company_profiles")[0]
    assert (emp.name, prof.display_name) == ("ravi.kumar", "ravi.kumar")


# ------------------------------------------------------------------ security
def test_setup_requires_a_verified_session(client: TestClient) -> None:
    assert client.post(SETUP).status_code == 401
    assert client.post(SETUP, headers={"Authorization": "Bearer not-a-token"}).status_code == 401
    forged = bearer(uuid.uuid4(), secret="x" * 64)
    assert client.post(SETUP, headers=forged).status_code == 401


def test_the_browser_cannot_choose_an_employer_or_an_owner(
    client: TestClient, admin_engine: Engine, make_tenant: MakeTenant
) -> None:
    victim = make_tenant("victim")
    user = uuid.uuid4()
    for kwargs in (
        {"json": {"employer_id": str(victim.employer_id)}},
        {
            "params": {
                "employer_id": str(victim.employer_id),
                "auth_user_id": str(victim.auth_user_id),
            }
        },
        {"headers": {"X-Employer-Id": str(victim.employer_id)}},
    ):
        headers = {**signed_up(user), **kwargs.pop("headers", {})}
        r = client.post(SETUP, headers=headers, **kwargs)
        assert r.status_code == 200
    mine = rows(admin_engine, "SELECT id FROM employers WHERE auth_user_id = :a", a=user)
    assert len(mine) == 1 and mine[0].id != victim.employer_id
    # the victim's data is untouched
    assert (
        rows(
            admin_engine,
            "SELECT display_name FROM company_profiles WHERE employer_id = :e",
            e=victim.employer_id,
        )[0].display_name
        == "Acme"
    )


def test_two_new_companies_are_completely_isolated(client: TestClient) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    ha = signed_up(a, "a@one.example", company_name="One Co")
    hb = signed_up(b, "b@two.example", company_name="Two Co")
    client.post(SETUP, headers=ha)
    client.post(SETUP, headers=hb)
    client.post(
        "/api/v1/imports/confirm",
        json={"filename": "x.csv", "rows": [{"customer_name": "Only One", "amount_due": "5"}]},
        headers=ha,
    )
    assert client.get("/api/v1/collections", headers=ha).json()["total"] == 1
    assert client.get("/api/v1/collections", headers=hb).json()["total"] == 0
    assert client.get("/api/v1/settings/company", headers=hb).json()["display_name"] == "Two Co"
    assert client.get("/api/v1/me", headers=hb).json()["employer"]["email"] == "b@two.example"


def test_an_email_that_already_has_an_account_cannot_be_claimed_again(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    make_tenant("dup")  # dup@example.test
    r = client.post(SETUP, headers=signed_up(uuid.uuid4(), "DUP@example.test"))
    assert r.status_code == 422 and "already exists" in r.json()["detail"]


def test_a_failure_halfway_leaves_no_partial_tenant(
    client: TestClient, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.workspace as ws

    def boom(*a: Any, **k: Any) -> None:
        raise RuntimeError("database went away")

    monkeypatch.setattr(
        ws, "_json", boom
    )  # fails AFTER employer, profile and settings rows were written
    user = uuid.uuid4()
    with pytest.raises(RuntimeError):
        client.post(SETUP, headers=signed_up(user))
    for table in ("employers", "company_profiles", "payment_settings", "audit_events"):
        assert rows(admin_engine, f"SELECT 1 FROM {table}") == [], table  # noqa: S608
    monkeypatch.undo()
    assert client.post(SETUP, headers=signed_up(user)).json() == {
        "created": True
    }  # and it can be retried


# ------------------------------------------------------------------ validation (server-side)
@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"email": "nope"}, "valid email"),
        ({"email": ""}, "valid email"),
        ({"full_name": "A"}, "full name"),
        ({"full_name": "x" * 81}, "full name"),
        ({"company_name": "B"}, "company name"),
        ({"company_name": "y" * 61}, "company name"),
        ({"phone": "12"}, "phone"),
        ({"phone": "98x65"}, "phone"),
    ],
)
def test_sign_up_details_are_validated(kwargs: dict[str, Any], message: str) -> None:
    base: dict[str, Any] = {
        "email": "a@b.example",
        "full_name": "Asha Rao",
        "company_name": "Acme",
        "phone": None,
    }
    with pytest.raises(WorkspaceError, match=message):
        clean_workspace(**{**base, **kwargs})


def test_details_are_normalised() -> None:
    ws = clean_workspace(
        email="  Asha@Acme.EXAMPLE ",
        full_name="  Asha   Rao ",
        company_name=" Acme  Traders",
        phone="98765 43210",
    )
    assert (ws.email, ws.full_name, ws.company_name, ws.phone) == (
        "asha@acme.example",
        "Asha Rao",
        "Acme Traders",
        "+919876543210",
    )
    assert (
        clean_workspace(
            email="a@b.example", full_name="Asha", company_name="Acme", phone="  "
        ).phone
        is None
    )


def test_metadata_of_the_wrong_type_is_ignored() -> None:
    ws = workspace_from_identity(
        "zed@shop.example", {"full_name": 123, "company_name": ["x"], "phone": {"a": 1}}
    )
    assert (ws.full_name, ws.company_name, ws.phone) == ("zed", "zed", None)


def test_bad_metadata_gives_a_clear_422_not_a_crash(client: TestClient) -> None:
    r = client.post(SETUP, headers=signed_up(uuid.uuid4(), phone="12"))
    assert r.status_code == 422 and "phone" in r.json()["detail"]
    assert (
        client.post(SETUP, headers=bearer(uuid.uuid4(), extra={"email": None})).status_code == 422
    )


# ------------------------------------------------------------------ admin provisioning
def test_the_operator_cli_creates_the_same_workspace(
    admin_engine: Engine, capsys: pytest.CaptureFixture[str]
) -> None:
    existing = uuid.uuid4()
    code = provisioning.main(
        ["create", "--full-name", "Ravi Shah", "--company", "Shah Stores", "--email", "ravi@shah.example",
         "--phone", "9876500000", "--auth-user-id", str(existing)]
    )  # fmt: skip
    assert code == 0 and "employer_id" in capsys.readouterr().out
    emp = rows(
        admin_engine, "SELECT id, name, phone FROM employers WHERE auth_user_id = :a", a=existing
    )[0]
    assert (emp.name, emp.phone) == ("Ravi Shah", "+919876500000")
    assert (
        rows(
            admin_engine,
            "SELECT display_name FROM company_profiles WHERE employer_id = :e",
            e=emp.id,
        )[0].display_name
        == "Shah Stores"
    )
    assert (
        len(rows(admin_engine, "SELECT 1 FROM payment_settings WHERE employer_id = :e", e=emp.id))
        == 1
    )
    assert (
        json.dumps(
            rows(admin_engine, "SELECT details FROM audit_events WHERE employer_id = :e", e=emp.id)[
                0
            ].details
        )
        == '{"method": "linked"}'
    )


def test_there_is_no_http_route_that_can_create_a_login_or_use_the_service_key(
    client: TestClient,
) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    assert not [p for p in paths if "provision" in p or "admin" in p]
    assert set(paths) >= {SETUP}
    assert "service_role" not in json.dumps(client.get("/openapi.json").json()).lower()


def test_existing_accounts_are_untouched_by_setup(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    t = make_tenant("old")
    before = rows(admin_engine, "SELECT name, email FROM employers WHERE id = :i", i=t.employer_id)
    r = client.post(
        SETUP,
        headers=bearer(t.auth_user_id, extra={"email": "old@example.test", "user_metadata": META}),
    )
    assert r.json() == {"created": False}
    assert (
        rows(admin_engine, "SELECT name, email FROM employers WHERE id = :i", i=t.employer_id)
        == before
    )
    assert (
        rows(
            admin_engine,
            "SELECT display_name FROM company_profiles WHERE employer_id = :i",
            i=t.employer_id,
        )[0].display_name
        == "Acme"
    )
    assert fresh_auth(t.auth_user_id)  # still a normal, working login
