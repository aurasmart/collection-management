"""The customer's payment page: no login, live data, the company's ONE general QR, rate limited."""

from __future__ import annotations

import io
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import Engine, text

from app.core.ratelimit import RateLimiter
from tests.conftest import Tenant, bearer
from tests.test_collections import add, first_id

MakeEmployer = Callable[[str], Tenant]

SETTINGS = {
    "display_name": "Acme Traders",
    "upi_id": "acme@okaxis",
    "upi_number": "9876543210",
    "bank_name": "HDFC Bank",
    "account_name": "Acme Traders Pvt Ltd",
    "account_number": "50100234567890",
    "ifsc": "HDFC0001234",
}


def qr_png() -> bytes:
    out = io.BytesIO()
    Image.effect_noise((320, 320), 70).convert("RGB").save(out, format="PNG")
    return out.getvalue()


def configure(
    admin_engine: Engine, storage_dir: Path, t: Tenant, *, qr: bytes | None = None, **flags: bool
) -> str | None:
    """Fill the company's payment settings (as the Settings screen would have)."""
    key = None
    if qr is not None:
        key = f"{t.employer_id}/qr/{uuid.uuid4()}.png"
        path = storage_dir / "qr" / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(qr)
    values: dict[str, Any] = {
        **SETTINGS,
        "e": t.employer_id,
        "qrk": key,
        "ue": flags.get("upi", True),
        "ne": flags.get("number", True),
        "qe": flags.get("qr_on", qr is not None),
        "be": flags.get("bank", True),
    }
    with admin_engine.connect() as c:
        c.execute(text("DELETE FROM payment_settings WHERE employer_id = :e"), {"e": t.employer_id})
        c.execute(
            text(
                "INSERT INTO payment_settings (employer_id, display_name, upi_id, upi_number, "
                "bank_name, account_name, account_number, ifsc, qr_code_storage_key, upi_enabled, "
                "upi_number_enabled, qr_enabled, bank_enabled) VALUES (:e, :display_name, "
                ":upi_id, :upi_number, :bank_name, :account_name, :account_number, :ifsc, :qrk, "
                ":ue, :ne, :qe, :be)"
            ),
            values,
        )
    return key


def page_token(client: TestClient, t: Tenant, name: str = "Rahul") -> tuple[str, str]:
    cid = first_id(client, t, name)
    r = client.post(f"/api/v1/collections/{cid}/payment-page", headers=bearer(t.auth_user_id))
    return cid, r.json()["payment_token"]


ROWS = [
    {
        "customer_name": "Rahul Sharma",
        "phone": "9876543210",
        "amount_due": "15000",
        "reference": "INV-1",
    },
    {"customer_name": "Priya Traders", "amount_due": "2500.50"},
]


def test_the_page_shows_this_customers_amount_and_the_company_payment_details(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    configure(admin_engine, storage_dir, t, qr=qr_png())
    _, token = page_token(client, t)
    r = client.get(f"/api/v1/public/pay/{token}")  # no Authorization header at all
    assert r.status_code == 200, r.text
    assert r.json() == {
        "state": "PENDING",
        "company_name": "Acme Traders",
        "customer_name": "Rahul Sharma",
        "amount_due": "15000.00",
        "reference": "INV-1",
        "upi_id": "acme@okaxis",
        "upi_number": "9876543210",
        "has_qr": True,
        "bank": {
            "bank_name": "HDFC Bank",
            "account_name": "Acme Traders Pvt Ltd",
            "account_number": "50100234567890",
            "ifsc": "HDFC0001234",
        },
    }
    assert r.headers["cache-control"] == "no-store"
    assert "noindex" in r.headers["x-robots-tag"]


def test_the_page_exposes_no_internal_ids_phones_or_other_customers(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    configure(admin_engine, storage_dir, t, qr=qr_png())
    cid, token = page_token(client, t)
    body = client.get(f"/api/v1/public/pay/{token}").text
    for secret in (cid, str(t.employer_id), "+919876543210", "Priya", "qr/", token, "Employer a"):
        assert secret not in body, secret


def test_the_qr_is_the_exact_general_company_image_for_every_customer(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    stored = qr_png()
    configure(admin_engine, storage_dir, t, qr=stored)
    _, tok1 = page_token(client, t, "Rahul")
    _, tok2 = page_token(client, t, "Priya")
    q1 = client.get(f"/api/v1/public/pay/{tok1}/qr")
    q2 = client.get(f"/api/v1/public/pay/{tok2}/qr")
    assert q1.status_code == q2.status_code == 200
    assert q1.headers["content-type"] == "image/png"
    # byte-for-byte what is stored: same for both customers, never altered by customer or amount
    assert q1.content == q2.content == stored


def test_disabled_methods_are_never_sent(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    configure(
        admin_engine, storage_dir, t, qr=qr_png(), upi=False, number=False, qr_on=False, bank=False
    )
    _, token = page_token(client, t)
    body = client.get(f"/api/v1/public/pay/{token}").json()
    assert (body["upi_id"], body["upi_number"], body["bank"], body["has_qr"]) == (
        None,
        None,
        None,
        False,
    )
    raw = client.get(f"/api/v1/public/pay/{token}").text
    for hidden in ("acme@okaxis", "9876543210", "50100234567890", "HDFC"):
        assert hidden not in raw
    assert client.get(f"/api/v1/public/pay/{token}/qr").status_code == 404


def test_the_page_shows_live_data_when_the_employer_edits_or_changes_settings(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    configure(admin_engine, storage_dir, t)
    cid, token = page_token(client, t)
    client.put(
        f"/api/v1/collections/{cid}",
        json={"customer_name": "Rahul S.", "amount_due": "16000"},
        headers=bearer(t.auth_user_id),
    )
    with admin_engine.connect() as c:
        c.execute(text("UPDATE payment_settings SET upi_id = 'new@okicici'"))
    page = client.get(f"/api/v1/public/pay/{token}").json()
    assert (page["customer_name"], page["amount_due"], page["upi_id"]) == (
        "Rahul S.",
        "16000.00",
        "new@okicici",
    )


def test_a_paid_customer_sees_payment_received_and_no_instructions(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    configure(admin_engine, storage_dir, t, qr=qr_png())
    cid, token = page_token(client, t)
    client.post(f"/api/v1/collections/{cid}/mark-paid", headers=bearer(t.auth_user_id))
    r = client.get(f"/api/v1/public/pay/{token}")
    assert r.json() == {
        "state": "PAID", "company_name": "Acme Traders", "customer_name": "Rahul Sharma",
        "amount_due": None, "reference": None, "upi_id": None, "upi_number": None,
        "has_qr": False, "bank": None,
    }  # fmt: skip
    assert client.get(f"/api/v1/public/pay/{token}/qr").status_code == 404
    client.post(f"/api/v1/collections/{cid}/mark-unpaid", headers=bearer(t.auth_user_id))
    assert (
        client.get(f"/api/v1/public/pay/{token}").json()["state"] == "PENDING"
    )  # same link works again


@pytest.mark.parametrize(
    "token",
    ["x" * 22, "short", "a" * 70, "bad token!!!!", "../../etc/passwd", "%00%00%00%00%00%00"],
)
def test_unknown_or_malformed_tokens_all_get_the_same_not_found(
    client: TestClient, token: str
) -> None:
    r = client.get(f"/api/v1/public/pay/{token}")
    assert r.status_code == 404  # never a validation error that reveals the token format
    if "/" not in token:  # a path with slashes never reaches the page route at all (plain 404)
        assert r.json() == {"detail": "This payment page is unavailable."}
    assert client.get(f"/api/v1/public/pay/{token}/qr").status_code == 404
    unknown = client.get(f"/api/v1/public/pay/{'a' * 22}")
    assert unknown.json() == {"detail": "This payment page is unavailable."}


def test_a_cancelled_customer_is_not_found(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    _, token = page_token(client, t)
    with admin_engine.connect() as c:
        c.execute(text("UPDATE collections SET status = 'CANCELLED'"))
    assert client.get(f"/api/v1/public/pay/{token}").status_code == 404


def test_one_employers_link_never_shows_another_employers_details(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine, storage_dir: Path
) -> None:
    a, b = make_employer("a"), make_employer("b")
    add(client, a, ROWS)
    add(client, b, [{"customer_name": "Rahul Beta", "amount_due": "1"}])
    configure(admin_engine, storage_dir, a, qr=qr_png())
    with admin_engine.connect() as c:
        c.execute(
            text(
                "INSERT INTO payment_settings (employer_id, display_name, upi_id, upi_enabled) "
                "VALUES (:e, 'Beta Co', 'beta@upi', true)"
            ),
            {"e": b.employer_id},
        )
    _, tb = page_token(client, b, "Rahul")
    page = client.get(f"/api/v1/public/pay/{tb}").json()
    assert (page["company_name"], page["upi_id"], page["bank"], page["has_qr"]) == (
        "Beta Co",
        "beta@upi",
        None,
        False,
    )
    assert client.get(f"/api/v1/public/pay/{tb}/qr").status_code == 404  # never A's QR


def test_the_company_name_falls_back_to_the_employer_name(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    _, token = page_token(client, t)  # no payment_settings row at all
    page = client.get(f"/api/v1/public/pay/{token}").json()
    assert page["company_name"] == "Employer a" and page["upi_id"] is None and page["bank"] is None


# ------------------------------------------------------------------ rate limiting
def test_page_loads_are_rate_limited_per_ip(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    _, token = page_token(client, t)
    codes = [client.get(f"/api/v1/public/pay/{token}").status_code for _ in range(61)]
    assert codes[:60] == [200] * 60
    assert codes[60] == 429
    blocked = client.get(f"/api/v1/public/pay/{token}")
    assert blocked.headers["retry-after"].isdigit()


def test_guessing_tokens_is_blocked_much_sooner(client: TestClient) -> None:
    codes = [
        client.get(f"/api/v1/public/pay/{uuid.uuid4().hex[:22]}").status_code for _ in range(17)
    ]
    assert codes[:15] == [404] * 15
    assert 429 in codes[15:]


def test_rate_limiter_window_slides_and_is_per_key() -> None:
    now = [0.0]
    rl = RateLimiter(limit=2, window_seconds=10, clock=lambda: now[0])
    assert rl.check("a") is None and rl.check("a") is None
    assert rl.check("a") == pytest.approx(10)
    assert rl.check("b") is None  # other callers are unaffected
    now[0] = 9.0
    assert rl.check("a") == pytest.approx(1)
    now[0] = 10.5
    assert rl.check("a") is None  # window moved on
