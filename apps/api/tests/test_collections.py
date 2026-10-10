"""Collections list/detail/edit, payment-page generation, Mark Paid / Mark Unpaid, dashboard."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from tests.conftest import Tenant, bearer

MakeEmployer = Callable[[str], Tenant]


def add(client: TestClient, t: Tenant, rows: list[dict[str, Any]]) -> None:
    r = client.post(
        "/api/v1/imports/confirm",
        json={"filename": "a.csv", "rows": rows},
        headers=bearer(t.auth_user_id),
    )
    assert r.status_code == 200, r.text


def listing(client: TestClient, t: Tenant, **params: Any) -> dict[str, Any]:
    r = client.get("/api/v1/collections", params=params, headers=bearer(t.auth_user_id))
    assert r.status_code == 200, r.text
    data: dict[str, Any] = r.json()
    return data


def first_id(client: TestClient, t: Tenant, name: str) -> str:
    items = listing(client, t, q=name)["items"]
    assert len(items) == 1
    cid: str = items[0]["id"]
    return cid


ROWS = [
    {
        "customer_name": "Rahul Sharma",
        "phone": "9876543210",
        "amount_due": "15000",
        "reference": "INV-1",
    },
    {
        "customer_name": "Priya Traders",
        "phone": "9876543211",
        "amount_due": "2500.50",
        "due_date": "20/10/2026",
    },
    {"customer_name": "Asha Stores", "amount_due": "800"},
]


def test_everything_needs_a_signed_in_employer(client: TestClient) -> None:
    some_id = "00000000-0000-0000-0000-000000000001"
    for method, path in [
        ("get", "/api/v1/collections"),
        ("get", f"/api/v1/collections/{some_id}"),
        ("put", f"/api/v1/collections/{some_id}"),
        ("post", f"/api/v1/collections/{some_id}/payment-page"),
        ("post", f"/api/v1/collections/{some_id}/mark-paid"),
        ("post", f"/api/v1/collections/{some_id}/mark-unpaid"),
        ("get", "/api/v1/dashboard"),
    ]:
        assert client.request(method, path).status_code == 401, path


def test_list_shows_customers_newest_first_with_search_and_status_filter(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    data = listing(client, t)
    assert data["total"] == 3
    first = next(i for i in data["items"] if i["customer_name"] == "Rahul Sharma")
    assert first == {
        "id": first["id"],
        "customer_name": "Rahul Sharma",
        "phone": "+919876543210",
        "amount_due": "15000.00",
        "due_date": None,
        "reference": "INV-1",
        "status": "PENDING",
        "has_payment_page": False,
        "has_receipt": False,
        "created_at": first["created_at"],
    }
    assert "payment_token" not in first  # tokens are never in the list
    assert [i["customer_name"] for i in listing(client, t, q="priya")["items"]] == ["Priya Traders"]
    assert [i["customer_name"] for i in listing(client, t, q="43210")["items"]] == ["Rahul Sharma"]
    assert [i["customer_name"] for i in listing(client, t, q="inv-1")["items"]] == ["Rahul Sharma"]
    assert listing(client, t, q="%")["total"] == 0  # LIKE wildcards are literal
    assert listing(client, t, status="PAID")["total"] == 0
    assert listing(client, t, status="PENDING")["total"] == 3
    assert (
        listing(client, t, limit=2)["total"] == 3 and len(listing(client, t, limit=2)["items"]) == 2
    )
    assert (
        client.get("/api/v1/collections?status=SENT", headers=bearer(t.auth_user_id)).status_code
        == 422
    )


def test_detail_and_cross_tenant_access(client: TestClient, make_employer: MakeEmployer) -> None:
    a, b = make_employer("a"), make_employer("b")
    add(client, a, ROWS)
    cid = first_id(client, a, "Rahul")
    ok = client.get(f"/api/v1/collections/{cid}", headers=bearer(a.auth_user_id))
    assert ok.status_code == 200 and ok.json()["customer_name"] == "Rahul Sharma"
    other = bearer(b.auth_user_id)
    assert client.get(f"/api/v1/collections/{cid}", headers=other).status_code == 404
    assert (
        client.put(
            f"/api/v1/collections/{cid}",
            json={"customer_name": "X", "amount_due": "1"},
            headers=other,
        ).status_code
        == 404
    )
    assert client.post(f"/api/v1/collections/{cid}/payment-page", headers=other).status_code == 404
    assert client.post(f"/api/v1/collections/{cid}/mark-paid", headers=other).status_code == 404
    assert client.post(f"/api/v1/collections/{cid}/mark-unpaid", headers=other).status_code == 404
    assert (
        client.get(f"/api/v1/collections/{cid}", headers=bearer(a.auth_user_id)).json()["status"]
        == "PENDING"
    )


def test_edit_updates_the_customer_and_audits_field_names_only(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    cid = first_id(client, t, "Rahul")
    body = {
        "customer_name": "Rahul S.",
        "phone": "98765 00000",
        "amount_due": "₹16,000",
        "reference": "INV-9",
        "due_date": "01/11/2026",
    }
    r = client.put(f"/api/v1/collections/{cid}", json=body, headers=bearer(t.auth_user_id))
    assert r.status_code == 200, r.text
    d = r.json()
    assert (d["customer_name"], d["phone"], d["amount_due"], d["reference"], d["due_date"]) == (
        "Rahul S.", "+919876500000", "16000.00", "INV-9", "2026-11-01",
    )  # fmt: skip
    with admin_engine.connect() as c:
        audit = c.execute(
            text("SELECT details FROM audit_events WHERE action = 'collection_edited'")
        ).scalar_one()
    assert set(audit["fields"]) == {"customer_name", "phone", "amount_due", "reference", "due_date"}
    assert "16000" not in json.dumps(audit) and "Rahul" not in json.dumps(audit)


def test_edit_validates_and_leaves_other_customers_alone(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, [ROWS[0], {**ROWS[0], "customer_name": "Rahul Twin"}])
    ids = {i["customer_name"]: i["id"] for i in listing(client, t)["items"]}
    h = bearer(t.auth_user_id)
    bad = client.put(
        f"/api/v1/collections/{ids['Rahul Sharma']}",
        json={"customer_name": "", "amount_due": "x", "phone": "1"},
        headers=h,
    )
    assert bad.status_code == 422
    assert {e["loc"][-1] for e in bad.json()["detail"]} == {"customer_name", "amount_due", "phone"}
    client.put(
        f"/api/v1/collections/{ids['Rahul Sharma']}",
        json={"customer_name": "Changed", "amount_due": "1"},
        headers=h,
    )
    twin = client.get(f"/api/v1/collections/{ids['Rahul Twin']}", headers=h).json()
    assert twin["customer_name"] == "Rahul Twin" and twin["phone"] == "+919876543210"
    forged = client.put(
        f"/api/v1/collections/{ids['Rahul Twin']}",
        json={"customer_name": "X", "amount_due": "1", "employer_id": str(t.employer_id)},
        headers=h,
    )
    assert forged.status_code == 422


def test_generate_payment_page_is_idempotent_and_never_audits_the_token(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    cid = first_id(client, t, "Rahul")
    h = bearer(t.auth_user_id)
    one = client.post(f"/api/v1/collections/{cid}/payment-page", headers=h).json()
    two = client.post(f"/api/v1/collections/{cid}/payment-page", headers=h).json()
    token = one["payment_token"]
    assert token and two["payment_token"] == token and one["has_payment_page"] is True
    assert len(token) >= 21 and all(ch.isalnum() or ch in "-_" for ch in token)  # 128-bit urlsafe
    other = client.post(
        f"/api/v1/collections/{first_id(client, t, 'Priya')}/payment-page", headers=h
    ).json()
    assert other["payment_token"] != token
    assert listing(client, t, q="Rahul")["items"][0]["has_payment_page"] is True
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT details::text FROM audit_events")).scalars().all()
    assert token not in " ".join(rows)


def test_mark_paid_and_mark_unpaid_are_simple_status_corrections(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    cid = first_id(client, t, "Rahul")
    h = bearer(t.auth_user_id)
    paid = client.post(f"/api/v1/collections/{cid}/mark-paid", headers=h).json()
    assert paid["status"] == "PAID"
    assert client.post(f"/api/v1/collections/{cid}/mark-paid", headers=h).json()["status"] == "PAID"
    back = client.post(f"/api/v1/collections/{cid}/mark-unpaid", headers=h).json()
    assert back["status"] == "PENDING" and back["amount_due"] == "15000.00"
    assert (
        client.post(f"/api/v1/collections/{cid}/mark-unpaid", headers=h).json()["status"]
        == "PENDING"
    )
    with admin_engine.connect() as c:
        actions = (
            c.execute(
                text(
                    "SELECT action FROM audit_events "
                    "WHERE entity_type='collection' ORDER BY created_at"
                )
            )
            .scalars()
            .all()
        )
        payments = c.execute(text("SELECT count(*) FROM payments")).scalar_one()
    assert actions == ["marked_paid", "marked_unpaid"]  # idempotent clicks are not logged twice
    assert payments == 0  # no payment records, history or reconciliation


def test_a_paid_customer_cannot_be_edited_until_marked_unpaid(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    cid = first_id(client, t, "Rahul")
    h = bearer(t.auth_user_id)
    client.post(f"/api/v1/collections/{cid}/mark-paid", headers=h)
    r = client.put(
        f"/api/v1/collections/{cid}", json={"customer_name": "X", "amount_due": "1"}, headers=h
    )
    assert r.status_code == 409
    client.post(f"/api/v1/collections/{cid}/mark-unpaid", headers=h)
    assert (
        client.put(
            f"/api/v1/collections/{cid}", json={"customer_name": "X", "amount_due": "1"}, headers=h
        ).status_code
        == 200
    )


def test_dashboard_numbers_follow_the_statuses(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    empty = client.get("/api/v1/dashboard", headers=h).json()
    assert empty == {
        "total_outstanding": "0.00",
        "pending_customers": 0,
        "paid_amount": "0.00",
        "customers": 0,
        "paid_customers": 0,
        "overdue_amount": "0.00",
        "overdue_customers": 0,
        "due_soon_amount": "0.00",
        "due_soon_customers": 0,
        "top_outstanding": [],
        "recent": [],
    }
    add(client, t, ROWS)
    d = client.get("/api/v1/dashboard", headers=h).json()
    assert (d["total_outstanding"], d["pending_customers"], d["paid_amount"], d["customers"]) == (
        "18300.50",
        3,
        "0.00",
        3,
    )
    client.post(f"/api/v1/collections/{first_id(client, t, 'Rahul')}/mark-paid", headers=h)
    d = client.get("/api/v1/dashboard", headers=h).json()
    assert (d["total_outstanding"], d["pending_customers"], d["paid_amount"], d["customers"]) == (
        "3300.50",
        2,
        "15000.00",
        3,
    )
    assert d["recent"][0] == {
        "id": first_id(client, t, "Rahul"),
        "customer_name": "Rahul Sharma",
        "amount_due": "15000.00",
        "status": "PAID",
        "due_date": None,
    }
    client.post(f"/api/v1/collections/{first_id(client, t, 'Rahul')}/mark-unpaid", headers=h)
    d = client.get("/api/v1/dashboard", headers=h).json()
    assert (d["total_outstanding"], d["paid_amount"]) == ("18300.50", "0.00")


def test_dashboard_is_per_employer_and_limited_to_ten_recent(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    a, b = make_employer("a"), make_employer("b")
    add(client, a, [{"customer_name": f"C{i}", "amount_due": "10"} for i in range(12)])
    da = client.get("/api/v1/dashboard", headers=bearer(a.auth_user_id)).json()
    db = client.get("/api/v1/dashboard", headers=bearer(b.auth_user_id)).json()
    assert da["customers"] == 12 and len(da["recent"]) == 10
    assert db["customers"] == 0 and db["recent"] == []


MORE = [
    {
        "customer_name": "Zed Stores",
        "phone": "9876543212",
        "amount_due": "50",
        "due_date": "01/01/2020",
    },
    {"customer_name": "Amit Hardware", "amount_due": "9000", "due_date": "01/01/2099"},
]


def names(data: dict[str, Any]) -> list[str]:
    return [i["customer_name"] for i in data["items"]]


def test_sorting_by_name_amount_due_date_and_added(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS + MORE)
    assert names(listing(client, t, sort="name_asc"))[:2] == ["Amit Hardware", "Asha Stores"]
    assert names(listing(client, t, sort="name_desc"))[0] == "Zed Stores"
    assert names(listing(client, t, sort="amount_desc"))[0] == "Rahul Sharma"
    assert names(listing(client, t, sort="amount_asc"))[0] == "Zed Stores"
    due = names(listing(client, t, sort="due_asc"))
    assert due[0] == "Zed Stores" and due[-1] in {"Rahul Sharma", "Asha Stores"}  # no date: last
    assert names(listing(client, t, sort="due_desc"))[0] == "Amit Hardware"
    assert len(names(listing(client, t, sort="created_asc"))) == 5
    bad = client.get(
        "/api/v1/collections", params={"sort": "name; DROP TABLE x"}, headers=bearer(t.auth_user_id)
    )
    assert bad.status_code == 422


def test_filters_narrow_the_list_and_the_total(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS + MORE)
    assert names(listing(client, t, overdue="true")) == ["Zed Stores"]
    assert listing(client, t, min_amount=1000)["total"] == 3
    assert names(listing(client, t, max_amount=100)) == ["Zed Stores"]
    assert names(listing(client, t, due_from="2098-01-01")) == ["Amit Hardware"]
    assert names(listing(client, t, due_to="2020-12-31")) == ["Zed Stores"]
    assert listing(client, t, has_phone="no")["total"] == 2
    assert listing(client, t, has_phone="yes")["total"] == 3
    assert listing(client, t, payment_page="yes")["total"] == 0
    client.post(
        f"/api/v1/collections/{first_id(client, t, 'Rahul')}/payment-page",
        headers=bearer(t.auth_user_id),
    )
    assert names(listing(client, t, payment_page="yes")) == ["Rahul Sharma"]
    assert listing(client, t, payment_page="no")["total"] == 4
    assert listing(client, t, created_from="2000-01-01", created_to="2099-12-31")["total"] == 5
    assert listing(client, t, created_to="2000-01-01")["total"] == 0
    both = listing(client, t, status="PENDING", min_amount=1000, sort="amount_asc", limit=1)
    assert both["total"] == 3 and names(both) == ["Priya Traders"]
    pid = first_id(client, t, "Zed")
    client.post(f"/api/v1/collections/{pid}/mark-paid", headers=bearer(t.auth_user_id))
    assert listing(client, t, overdue="true")["total"] == 0  # a paid customer is not overdue


def test_delete_one_removes_the_customer_the_link_and_keeps_the_audit(
    client: TestClient, make_employer: MakeEmployer, admin_engine: Engine
) -> None:
    t = make_employer("a")
    add(client, t, ROWS)
    h = bearer(t.auth_user_id)
    cid = first_id(client, t, "Rahul")
    token = client.post(f"/api/v1/collections/{cid}/payment-page", headers=h).json()[
        "payment_token"
    ]
    assert client.get(f"/api/v1/public/pay/{token}").status_code == 200
    assert client.delete(f"/api/v1/collections/{cid}", headers=h).status_code == 204
    assert client.get(f"/api/v1/collections/{cid}", headers=h).status_code == 404
    assert client.delete(f"/api/v1/collections/{cid}", headers=h).status_code == 404
    assert client.get(f"/api/v1/public/pay/{token}").status_code == 404
    assert listing(client, t)["total"] == 2
    with admin_engine.connect() as c:
        left = c.execute(
            text("SELECT count(*) FROM customers WHERE name = 'Rahul Sharma'")
        ).scalar()
        events = (
            c.execute(
                text("SELECT details::text FROM audit_events WHERE action = 'collection_deleted'")
            )
            .scalars()
            .all()
        )
    assert left == 0 and len(events) == 1
    assert "Rahul Sharma" in events[0] and token not in events[0]
    dash = client.get("/api/v1/dashboard", headers=h).json()
    assert dash["customers"] == 2


def test_bulk_delete_is_all_or_nothing_and_ignores_other_employers(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    a, b = make_employer("a"), make_employer("b")
    add(client, a, ROWS)
    add(client, b, [{"customer_name": "Other Co", "amount_due": "10"}])
    ha = bearer(a.auth_user_id)
    ids = [first_id(client, a, n) for n in ("Rahul", "Priya")]
    foreign = first_id(client, b, "Other")
    paid = first_id(client, a, "Asha")
    client.post(f"/api/v1/collections/{paid}/mark-paid", headers=ha)
    r = client.post("/api/v1/collections/delete", json={"ids": [*ids, paid, foreign]}, headers=ha)
    assert r.status_code == 200 and r.json() == {"deleted": 3}
    assert listing(client, a)["total"] == 0
    assert listing(client, b)["total"] == 1  # the other employer's row is untouched
    bodies: list[dict[str, Any]] = [{"ids": []}, {"ids": ["not-a-uuid"]}, {"ids": [foreign] * 201}]
    for body in bodies:
        assert client.post("/api/v1/collections/delete", json=body, headers=ha).status_code == 422


def test_delete_needs_sign_in(client: TestClient) -> None:
    some = "00000000-0000-0000-0000-000000000001"
    assert client.delete(f"/api/v1/collections/{some}").status_code == 401
    assert client.post("/api/v1/collections/delete", json={"ids": [some]}).status_code == 401


def test_dashboard_insights_overdue_due_soon_and_top_outstanding(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    add(client, t, ROWS + MORE)
    h = bearer(t.auth_user_id)
    d = client.get("/api/v1/dashboard", headers=h).json()
    assert d["overdue_customers"] == 1 and d["overdue_amount"] == "50.00"
    assert d["due_soon_customers"] == 0 and d["paid_customers"] == 0
    assert [r["customer_name"] for r in d["top_outstanding"]][:2] == [
        "Rahul Sharma",
        "Amit Hardware",
    ]
    assert all("payment_token" not in r for r in d["top_outstanding"])
    client.post(f"/api/v1/collections/{first_id(client, t, 'Zed')}/mark-paid", headers=h)
    d = client.get("/api/v1/dashboard", headers=h).json()
    assert d["overdue_customers"] == 0 and d["paid_customers"] == 1
