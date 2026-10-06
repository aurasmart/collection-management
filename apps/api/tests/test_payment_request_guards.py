"""Schema-level guards for the payment-request token/snapshot model (ADR 0001).

These prove the database enforces the approved rules; the payment-request *feature* is Phase 4.
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.db import tenant_session
from tests.conftest import Tenant

MakeTenant = Callable[[str], Tenant]

NEW_REQUEST = text(
    "INSERT INTO payment_requests (employer_id, collection_id, token_hash, token_ciphertext, "
    "token_key_id, status, snapshot_customer_name, snapshot_amount_requested, "
    "snapshot_employer_display_name, snapshot_enabled_methods) "
    "VALUES (:e, :c, :h, :ct, :kid, :st, 'Cust', 100, 'Acme', '[\"UPI\"]'::jsonb)"
)


def _new(t: Tenant, *, status: str = "REVOKED", ct: bytes | None = None, kid: str | None = None):  # type: ignore[no-untyped-def]
    return {
        "e": t.employer_id,
        "c": t.ids["collection"],
        "h": secrets.token_hex(32),
        "ct": ct,
        "kid": kid,
        "st": status,
    }


def test_only_one_active_request_per_collection(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")  # seed already has one ACTIVE request
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(NEW_REQUEST, _new(a, status="ACTIVE", ct=b"x", kid="k1"))


def test_active_request_requires_encrypted_token(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with tenant_session(a.employer_id) as s:  # free the active slot legitimately
        s.execute(
            text(
                "UPDATE payment_requests SET status='REVOKED', token_ciphertext=NULL, "
                "token_key_id=NULL, revoked_at=now()"
            )
        )
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(NEW_REQUEST, _new(a, status="ACTIVE"))  # ACTIVE without ciphertext


def test_revoking_must_erase_the_encrypted_token(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(text("UPDATE payment_requests SET status='REVOKED', revoked_at=now()"))


def test_revoke_with_erase_succeeds_and_ciphertext_is_gone(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with tenant_session(a.employer_id) as s:
        s.execute(
            text(
                "UPDATE payment_requests SET status='REVOKED', token_ciphertext=NULL, "
                "token_key_id=NULL, revoked_at=now(), revoked_reason='test'"
            )
        )
    with tenant_session(a.employer_id) as s:
        row = s.execute(text("SELECT status, token_ciphertext FROM payment_requests")).one()
        assert (row.status, row.token_ciphertext) == ("REVOKED", None)


@pytest.mark.parametrize(
    "assignment",
    [
        "snapshot_amount_requested = 1",
        "snapshot_customer_name = 'Changed'",
        "snapshot_upi_id = 'evil@upi'",
        "snapshot_enabled_methods = '[]'::jsonb",
        "token_hash = 'forged'",
        "collection_id = gen_random_uuid()",
    ],
)
def test_snapshot_and_token_hash_are_immutable(assignment: str, make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
        s.execute(text(f"UPDATE payment_requests SET {assignment}"))  # noqa: S608


def test_ciphertext_cannot_be_modified_while_active(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
        s.execute(text("UPDATE payment_requests SET token_ciphertext = '\\x00'::bytea"))


def test_revoked_request_can_never_become_active_again(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with tenant_session(a.employer_id) as s:
        s.execute(
            text(
                "UPDATE payment_requests SET status='REVOKED', token_ciphertext=NULL, "
                "token_key_id=NULL"
            )
        )
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
        s.execute(
            text(
                "UPDATE payment_requests SET status='ACTIVE', token_ciphertext='\\x01'::bytea, "
                "token_key_id='k1'"
            )
        )


def test_ocr_rows_must_require_review(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(
            text(
                "INSERT INTO import_rows (employer_id, batch_id, row_number, source_method, "
                "requires_review) VALUES (:e, :b, 2, 'OCR', false)"
            ),
            {"e": a.employer_id, "b": a.ids["batch"]},
        )


def test_collection_amount_and_status_constraints(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    for amount, status in (
        (0, "PENDING"),
        (-5, "PENDING"),
        (10, "OVERDUE"),
        (10, "PARTIALLY_PAID"),
    ):
        with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
            s.execute(
                text(
                    "INSERT INTO collections (employer_id, customer_id, amount_due, status) "
                    "VALUES (:e, :c, :a, :s)"
                ),
                {"e": a.employer_id, "c": a.ids["customer"], "a": amount, "s": status},
            )


def test_client_supplied_uuid_gives_idempotent_payment_insert(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    pid = uuid.uuid4()
    sql = text(
        "INSERT INTO payments (id, employer_id, collection_id, amount, payment_date, "
        "payment_method, created_by) VALUES (:i, :e, :c, 50, current_date, 'UPI', :u)"
    )
    params = {"i": pid, "e": a.employer_id, "c": a.ids["collection"], "u": a.auth_user_id}
    with tenant_session(a.employer_id) as s:
        s.execute(sql, params)
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(sql, params)  # same client UUID -> PK conflict (ADR 0003 A5)
