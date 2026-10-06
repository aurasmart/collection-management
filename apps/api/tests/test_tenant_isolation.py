"""Tenant isolation (RLS) — the Phase 0 security gate.

Seeds two employers with a row in every tenant table, then proves employer A can never
read, write, update, delete or reference employer B's data through the app's tenant session.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any, cast

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.db import tenant_session
from tests.conftest import TENANT_TABLES, Tenant

MakeTenant = Callable[[str], Tenant]


def test_tenant_session_runs_as_non_bypass_role(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    with tenant_session(a.employer_id) as s:
        assert s.execute(text("SELECT current_user")).scalar_one() == "app_rls"
        bypass = s.execute(
            text("SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user")
        ).scalar_one()
        assert bypass is False
        assert s.execute(text("SELECT current_setting('app.employer_id')")).scalar_one() == str(
            a.employer_id
        )


@pytest.mark.parametrize("table", ["employers", *TENANT_TABLES])
def test_each_tenant_sees_only_its_own_rows(table: str, make_tenant: MakeTenant) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    for tenant, other in ((a, b), (b, a)):
        with tenant_session(tenant.employer_id) as s:
            col = "id" if table == "employers" else "employer_id"
            rows = s.execute(text(f"SELECT {col} FROM {table}")).scalars().all()  # noqa: S608
            assert [str(r) for r in rows] == [str(tenant.employer_id)]
            assert str(other.employer_id) not in {str(r) for r in rows}


def test_no_tenant_context_sees_nothing(make_tenant: MakeTenant) -> None:
    make_tenant("a")
    from app.core.db import get_engine

    with get_engine().connect() as conn, conn.begin():
        conn.execute(text("SET LOCAL ROLE app_rls"))
        for table in ["employers", *TENANT_TABLES]:
            assert conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0  # noqa: S608


def test_cannot_insert_rows_for_another_tenant(make_tenant: MakeTenant) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
        s.execute(
            text("INSERT INTO customers (employer_id, name) VALUES (:e, 'Injected')"),
            {"e": b.employer_id},
        )


def test_cannot_update_or_delete_another_tenants_rows(
    make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    with tenant_session(a.employer_id) as s:
        upd = s.execute(
            text("UPDATE collections SET reference = 'hacked' WHERE id = :i"),
            {"i": b.ids["collection"]},
        )
        assert cast(CursorResult[Any], upd).rowcount == 0
        dele = s.execute(text("DELETE FROM import_rows WHERE id = :i"), {"i": b.ids["row"]})
        assert cast(CursorResult[Any], dele).rowcount == 0
    with admin_engine.connect() as c:
        ref = c.execute(
            text("SELECT reference FROM collections WHERE id = :i"), {"i": b.ids["collection"]}
        ).scalar_one()
        assert ref is None


def test_cannot_reference_another_tenants_parent(make_tenant: MakeTenant) -> None:
    """Composite (id, employer_id) foreign keys block cross-tenant links even without RLS."""
    a, b = make_tenant("a"), make_tenant("b")
    with pytest.raises(IntegrityError), tenant_session(a.employer_id) as s:
        s.execute(
            text(
                "INSERT INTO collections (employer_id, customer_id, amount_due) "
                "VALUES (:e, :c, 500)"
            ),
            {"e": a.employer_id, "c": b.ids["customer"]},
        )


def test_tenant_cannot_enumerate_employers_via_resolver(make_tenant: MakeTenant) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
        s.execute(text("SELECT resolve_employer_id(:u)"), {"u": b.auth_user_id})


def test_audit_events_are_append_only(make_tenant: MakeTenant, admin_engine: Engine) -> None:
    a = make_tenant("a")
    with tenant_session(a.employer_id) as s:  # insert allowed
        s.execute(
            text(
                "INSERT INTO audit_events (employer_id, actor, entity_type, action) "
                "VALUES (:e, 'me', 'collection', 'edited')"
            ),
            {"e": a.employer_id},
        )
    with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:  # no UPDATE grant
        s.execute(text("UPDATE audit_events SET action = 'x'"))
    with pytest.raises(DBAPIError), admin_engine.connect() as c:  # trigger blocks even the owner
        c.execute(text("DELETE FROM audit_events"))


def test_tenant_role_cannot_delete_financial_records(make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    for table in ("payments", "collections", "payment_requests"):
        with pytest.raises(DBAPIError), tenant_session(a.employer_id) as s:
            s.execute(text(f"DELETE FROM {table}"))  # noqa: S608


def test_every_public_table_has_rls_and_a_policy(admin_engine: Engine) -> None:
    """Guardrail for future migrations: no table may be added without RLS."""
    with admin_engine.connect() as c:
        rows = c.execute(
            text(
                "SELECT c.relname, c.relrowsecurity, "
                "(SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies "
                "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'alembic_version'"
            )
        ).all()
    assert rows, "expected tables"
    unprotected = [r.relname for r in rows if not r.relrowsecurity or r.policies == 0]
    assert unprotected == []


def test_every_tenant_table_has_employer_id(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        cols = {
            r.table_name
            for r in c.execute(
                text(
                    "SELECT table_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND column_name = 'employer_id'"
                )
            )
        }
    assert set(TENANT_TABLES) <= cols


def test_unused_uuid_helper() -> None:  # keeps the uuid import honest for type-checkers
    assert uuid.UUID(int=0).int == 0
