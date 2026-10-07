"""Payment settings: authN/authZ, tenant isolation, validation, re-authentication, audit."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from tests.conftest import Tenant, bearer, fresh_auth, stale_auth

MakeTenant = Callable[[str], Tenant]
URL = "/api/v1/settings/payment"

UPI_BODY: dict[str, Any] = {
    "upi_id": "acme@okaxis",
    "upi_number": "9876543210",
    "upi_enabled": True,
    "upi_number_enabled": True,
}
BANK_BODY: dict[str, Any] = {
    "bank_name": "HDFC Bank",
    "account_name": "Acme Traders Pvt Ltd",
    "account_number": "50100234567890",
    "ifsc": "hdfc0001234",
    "bank_enabled": True,
}


def audit_rows(engine: Engine, employer_id: Any) -> list[Any]:
    with engine.connect() as c:
        return list(
            c.execute(
                text(
                    "SELECT actor, action, details FROM audit_events "
                    "WHERE employer_id = :e AND entity_type = 'payment_settings' "
                    "ORDER BY created_at"
                ),
                {"e": employer_id},
            )
        )


# ------------------------------------------------------------------ authentication
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", URL),
        ("put", URL),
        ("put", f"{URL}/qr"),
        ("delete", f"{URL}/qr"),
        ("get", f"{URL}/qr"),
    ],
)
def test_every_settings_endpoint_requires_authentication(
    client: TestClient, method: str, path: str
) -> None:
    assert client.request(method, path).status_code == 401


def test_user_without_a_workspace_is_forbidden(client: TestClient) -> None:
    import uuid

    assert client.get(URL, headers=bearer(uuid.uuid4())).status_code == 403


# ------------------------------------------------------------------ read / write
def test_empty_state_is_returned_for_a_new_employer(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    with admin_engine.connect() as c:
        c.execute(text("DELETE FROM payment_settings WHERE employer_id = :e"), {"e": a.employer_id})
    body = client.get(URL, headers=bearer(a.auth_user_id)).json()
    assert body["has_qr"] is False
    assert not any(
        body[k] for k in ("upi_enabled", "upi_number_enabled", "qr_enabled", "bank_enabled")
    )
    assert body["recent_changes"] == []


def test_display_name_no_longer_lives_in_payment_settings(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json={"display_name": "New Name"}, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 422  # it is a Company Profile field now
    assert "display_name" not in client.get(URL, headers=bearer(a.auth_user_id)).json()


def test_unchanged_save_is_a_noop_without_audit(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    h = fresh_auth(a.auth_user_id)
    assert client.put(URL, json=UPI_BODY, headers=h).status_code == 200
    before = len(audit_rows(admin_engine, a.employer_id))
    assert client.put(URL, json=UPI_BODY, headers=bearer(a.auth_user_id)).status_code == 200
    assert len(audit_rows(admin_engine, a.employer_id)) == before


# ------------------------------------------------------------------ re-authentication
@pytest.mark.parametrize("body", [UPI_BODY, BANK_BODY])
def test_sensitive_change_without_any_password_signin_is_rejected(
    body: dict[str, Any], client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=body, headers=bearer(a.auth_user_id))  # no amr claim at all
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "reauth_required"
    assert audit_rows(admin_engine, a.employer_id) == []
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["upi_id"] is None


def test_stale_authentication_is_rejected_and_nothing_changes(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=UPI_BODY, headers=stale_auth(a.auth_user_id))
    assert (r.status_code, r.json()["detail"]["code"]) == (403, "reauth_required")
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["upi_id"] is None
    assert audit_rows(admin_engine, a.employer_id) == []


def test_recent_authentication_allows_the_change_and_is_audited(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=BANK_BODY, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 200, r.text
    assert r.json()["ifsc"] == "HDFC0001234"  # normalised
    last = audit_rows(admin_engine, a.employer_id)[-1]
    assert last.action == "settings_changed"
    assert set(last.details["fields"]) >= {"bank_name", "account_number", "ifsc", "bank_enabled"}
    assert last.details["reauthenticated"] is True
    assert last.actor == "user@example.test"


def test_audit_stores_field_names_never_values(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    client.put(URL, json={**UPI_BODY, **BANK_BODY}, headers=fresh_auth(a.auth_user_id))
    blob = json.dumps([dict(r.details) for r in audit_rows(admin_engine, a.employer_id)])
    for secret in ("acme@okaxis", "9876543210", "50100234567890", "HDFC0001234", "Acme Traders"):
        assert secret not in blob


def test_recent_changes_lists_last_five_with_who_when_what(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    for i in range(7):
        r = client.put(URL, json={"upi_id": f"name{i}@okaxis"}, headers=fresh_auth(a.auth_user_id))
        assert r.status_code == 200, r.text
    changes = client.get(URL, headers=bearer(a.auth_user_id)).json()["recent_changes"]
    assert len(changes) == 5
    assert changes[0]["fields"] == ["upi_id"]
    assert changes[0]["actor"] == "user@example.test"
    assert changes[0]["at"] >= changes[-1]["at"]


# ------------------------------------------------------------------ validation (server-side)
@pytest.mark.parametrize(
    ("patch", "field"),
    [
        ({"upi_id": "no-at-sign"}, "upi_id"),
        ({"upi_id": "a b@bank"}, "upi_id"),
        ({"upi_number": "12345"}, "upi_number"),
        ({"upi_number": "5876543210"}, "upi_number"),
        ({"upi_number": "98765abcde"}, "upi_number"),
        ({"ifsc": "HDFC1234567"}, "ifsc"),
        ({"ifsc": "HDF0001234"}, "ifsc"),
        ({"account_number": "12345678"}, "account_number"),
        ({"account_number": "1234567890123456789"}, "account_number"),
        ({"account_number": "12345abc9"}, "account_number"),
        ({"bank_name": "x"}, "bank_name"),
        ({"account_name": "x"}, "account_name"),
    ],
)
def test_field_format_validation(
    patch: dict[str, Any], field: str, client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=patch, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 422
    assert field in [e["loc"][-1] for e in r.json()["detail"]]


@pytest.mark.parametrize(
    ("patch", "field"),
    [
        ({"upi_enabled": True}, "upi_id"),
        ({"upi_number_enabled": True}, "upi_number"),
        ({"qr_enabled": True}, "qr_enabled"),
        ({"bank_enabled": True}, "bank_name"),
        ({"bank_enabled": True, "bank_name": "HDFC Bank"}, "account_name"),
        (
            {
                "bank_enabled": True,
                "bank_name": "HDFC",
                "account_name": "Acme",
                "ifsc": "HDFC0001234",
            },
            "account_number",
        ),
    ],
)
def test_enabled_methods_must_be_fully_configured(
    patch: dict[str, Any], field: str, client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=patch, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 422
    assert field in [e["loc"][-1] for e in r.json()["detail"]]


def test_blank_strings_are_treated_as_empty_and_disabled_methods_may_be_partial(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    body = {"upi_id": "  ", "bank_name": "HDFC Bank"}  # bank disabled
    r = client.put(URL, json=body, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["upi_id"], out["bank_name"]) == (None, "HDFC Bank")


def test_saving_with_no_enabled_method_is_allowed_incomplete_state(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json={}, headers=bearer(a.auth_user_id))
    assert r.status_code == 200
    assert not any(
        r.json()[k] for k in ("upi_enabled", "upi_number_enabled", "qr_enabled", "bank_enabled")
    )


# ---------------------------------------------- tenant isolation / forged employer_id
def test_forged_employer_id_in_body_is_rejected_and_ignored(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    r = client.put(
        URL,
        json={"upi_id": "hijack@okaxis", "employer_id": str(b.employer_id)},
        headers=fresh_auth(a.auth_user_id),
    )
    assert r.status_code == 422
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT employer_id, upi_id FROM payment_settings")).all()
    upis: dict[Any, Any] = {r.employer_id: r.upi_id for r in rows}
    assert upis[b.employer_id] is None  # untouched seed value
    assert upis[a.employer_id] is None


def test_forged_employer_id_in_query_and_headers_is_ignored(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    client.put(URL, json={"upi_id": "alpha@okaxis"}, headers=fresh_auth(a.auth_user_id))
    client.put(URL, json={"upi_id": "beta@okaxis"}, headers=fresh_auth(b.auth_user_id))
    r = client.get(
        URL,
        params={"employer_id": str(b.employer_id)},
        headers={**bearer(a.auth_user_id), "X-Employer-Id": str(b.employer_id)},
    )
    assert r.json()["upi_id"] == "alpha@okaxis"


def test_each_employer_only_ever_sees_and_changes_its_own_settings(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    assert client.put(URL, json=UPI_BODY, headers=fresh_auth(a.auth_user_id)).status_code == 200
    seen_by_b = client.get(URL, headers=bearer(b.auth_user_id)).json()
    assert seen_by_b["upi_id"] is None
    assert seen_by_b["recent_changes"] == []
    other = {**UPI_BODY, "upi_id": "bravo@okicici"}
    assert client.put(URL, json=other, headers=fresh_auth(b.auth_user_id)).status_code == 200
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["upi_id"] == "acme@okaxis"
