from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

import jwt
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import JWT_SECRET, Tenant, bearer, make_jwt

MakeTenant = Callable[[str], Tenant]
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_health_and_readiness(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ok"}


def test_security_headers_present(client: TestClient) -> None:
    h = client.get("/healthz").headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["cache-control"] == "no-store"


def test_cors_allows_only_configured_origin(client: TestClient) -> None:
    ok = client.options(
        "/api/v1/me",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.options(
        "/api/v1/me",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in bad.headers


def test_me_requires_authentication(client: TestClient) -> None:
    r = client.get("/api/v1/me")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


def test_me_rejects_bad_tokens(client: TestClient) -> None:
    sub = uuid.uuid4()
    bad_tokens = {
        "wrong secret": make_jwt(sub, secret="x" * 40),
        "expired": make_jwt(sub, expires_in=timedelta(seconds=-60)),
        "wrong audience": make_jwt(sub, audience="someone-else"),
        "wrong algorithm": make_jwt(sub, algorithm="HS512", secret=JWT_SECRET),
        "alg none": jwt.encode(
            {"sub": str(sub), "aud": "authenticated", "exp": 9999999999},
            None,  # type: ignore[arg-type]
            algorithm="none",
        ),
        "garbage": "not-a-jwt",
    }
    for name, token in bad_tokens.items():
        r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401, name


def test_me_forbidden_when_no_workspace_is_linked(client: TestClient) -> None:
    r = client.get("/api/v1/me", headers=bearer(uuid.uuid4()))
    assert r.status_code == 403


def test_me_returns_the_callers_employer(client: TestClient, make_tenant: MakeTenant) -> None:
    a, _b = make_tenant("a"), make_tenant("b")
    r = client.get("/api/v1/me", headers=bearer(a.auth_user_id))
    assert r.status_code == 200
    assert r.json()["employer"]["id"] == str(a.employer_id)
    assert r.json()["employer"]["name"] == "Employer a"


def test_employer_id_is_never_taken_from_the_request(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    r = client.get(
        "/api/v1/me",
        params={"employer_id": str(b.employer_id)},
        headers={**bearer(a.auth_user_id), "X-Employer-Id": str(b.employer_id)},
    )
    assert r.status_code == 200
    assert r.json()["employer"]["id"] == str(a.employer_id)


def test_openapi_contract_matches_committed_file() -> None:
    """The frontend types are generated from packages/api-types/openapi.json; keep it in sync.

    Regenerate with `make api-types`.
    """
    committed = json.loads((REPO_ROOT / "packages/api-types/openapi.json").read_text())
    current = json.loads(json.dumps(create_app().openapi(), sort_keys=True))
    assert committed == current
