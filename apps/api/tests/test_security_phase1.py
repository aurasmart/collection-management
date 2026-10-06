from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.core.security import _last_password_auth
from tests.conftest import make_jwt


def test_amr_parsing_picks_latest_password_entry_and_ignores_junk() -> None:
    now = int(datetime.now(UTC).timestamp())
    assert _last_password_auth({}) is None
    assert _last_password_auth({"amr": "password"}) is None
    assert _last_password_auth({"amr": [{"method": "otp", "timestamp": now}]}) is None
    assert _last_password_auth({"amr": [{"method": "password", "timestamp": True}]}) is None
    assert _last_password_auth({"amr": [{"method": "password", "timestamp": "now"}]}) is None
    got = _last_password_auth(
        {
            "amr": [
                {"method": "password", "timestamp": now - 500},
                {"method": "password", "timestamp": now},
            ]
        }
    )
    assert got is not None and int(got.timestamp()) == now


def test_user_cannot_forge_a_fresh_amr_without_the_signing_key(client: TestClient) -> None:
    forged = make_jwt(
        uuid.uuid4(),
        secret="x" * 48,
        password_auth_age=None,
        extra={"amr": [{"method": "password", "timestamp": int(datetime.now(UTC).timestamp())}]},
    )
    r = client.put(
        "/api/v1/settings/payment",
        json={"display_name": "Acme", "upi_id": "a@b.co", "upi_enabled": True},
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert r.status_code == 401


def test_rejected_tokens_never_appear_in_logs(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    token = make_jwt(uuid.uuid4(), secret="y" * 48)
    with caplog.at_level(logging.DEBUG):
        assert (
            client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"}).status_code
            == 401
        )
    assert token not in caplog.text
    assert token.split(".")[1] not in caplog.text
