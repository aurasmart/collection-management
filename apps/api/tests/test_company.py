"""Company profile: CRUD, isolation, validation, logo upload, re-auth, public page, migration."""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import Engine, text

from app.core.config import get_settings
from tests.conftest import Tenant, alembic_config, bearer, fresh_auth, stale_auth
from tests.test_collections import add
from tests.test_public_pay import configure, page_token, qr_png

MakeTenant = Callable[[str], Tenant]
URL = "/api/v1/settings/company"
LOGO = f"{URL}/logo"

FULL: dict[str, Any] = {
    "display_name": "Acme Traders",
    "legal_name": "Acme Holdings LLP",
    "address": "12 MG Road",
    "city": "Pune",
    "state": "Maharashtra",
    "pin": "411001",
    "gstin": "27abcde1234f1z5",
    "pan": "abcde1234f",
    "contact_person": "Asha Rao",
    "phone": "98765 43210",
    "email": "Accounts@Acme.example",
    "website": "acme.example",
}


def image(fmt: str = "PNG", size: tuple[int, int] = (200, 120), mode: str = "RGB") -> bytes:
    out = io.BytesIO()
    Image.effect_noise(size, 80).convert(mode).save(out, format=fmt)
    return out.getvalue()


def logo_files(storage_dir: Path, t: Tenant) -> list[Path]:
    root = storage_dir / "qr" / str(t.employer_id) / "logo"
    return sorted(root.glob("*.png")) if root.exists() else []


def plain(size: tuple[int, int]) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, "navy").save(out, format="PNG")
    return out.getvalue()


def put_logo(
    client: TestClient, headers: dict[str, str], data: bytes, name: str = "logo.png"
) -> Any:
    return client.put(LOGO, files={"file": (name, data, "image/png")}, headers=headers)


# ------------------------------------------------------------------ auth
@pytest.mark.parametrize(
    ("method", "path"),
    [("get", URL), ("put", URL), ("put", LOGO), ("delete", LOGO), ("get", LOGO)],
)
def test_every_company_endpoint_requires_authentication(
    client: TestClient, method: str, path: str
) -> None:
    assert getattr(client, method)(path).status_code in (401, 403)


# ------------------------------------------------------------------ read / write
def test_a_new_employer_sees_the_account_name_prefilled(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    with admin_engine.connect() as c:
        c.execute(text("DELETE FROM company_profiles WHERE employer_id = :e"), {"e": a.employer_id})
    body = client.get(URL, headers=bearer(a.auth_user_id)).json()
    assert body["display_name"] == "Employer a"
    assert body["saved"] is False
    assert body["has_logo"] is False
    assert body["recent_changes"] == []


def test_save_normalises_and_returns_every_field(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json=FULL, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["saved"] is True
    assert out["gstin"] == "27ABCDE1234F1Z5"
    assert out["pan"] == "ABCDE1234F"
    assert out["phone"] == "+919876543210"
    assert out["email"] == "accounts@acme.example"
    assert out["website"] == "https://acme.example"
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["city"] == "Pune"


def test_only_the_display_name_is_required(client: TestClient, make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    r = client.put(URL, json={"display_name": "Acme"}, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 200, r.text
    assert r.json()["legal_name"] is None
    assert client.put(URL, json={}, headers=fresh_auth(a.auth_user_id)).status_code == 422


def test_blank_optional_fields_become_empty(client: TestClient, make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    client.put(URL, json=FULL, headers=fresh_auth(a.auth_user_id))
    r = client.put(
        URL,
        json={"display_name": "Acme", "city": "   ", "gstin": "", "phone": " "},
        headers=fresh_auth(a.auth_user_id),
    )
    assert (r.json()["city"], r.json()["gstin"], r.json()["phone"]) == (None, None, None)


# ------------------------------------------------------------------ validation
@pytest.mark.parametrize(
    ("patch", "field"),
    [
        ({"display_name": "A"}, "display_name"),
        ({"display_name": "x" * 61}, "display_name"),
        ({"pin": "12345"}, "pin"),
        ({"pin": "012345"}, "pin"),
        ({"gstin": "NOTAGSTIN"}, "gstin"),
        ({"pan": "12345ABCDE"}, "pan"),
        ({"phone": "12"}, "phone"),
        ({"phone": "98x65"}, "phone"),
        ({"email": "not-an-email"}, "email"),
        ({"website": "javascript:alert(1)"}, "website"),
        ({"website": "ftp://example.com"}, "website"),
        ({"website": "http://no-dot"}, "website"),
        ({"address": "x" * 201}, "address"),
        ({"city": "x" * 61}, "city"),
        ({"legal_name": "x" * 121}, "legal_name"),
    ],
)
def test_invalid_values_are_rejected_with_the_field_named(
    client: TestClient, make_tenant: MakeTenant, patch: dict[str, Any], field: str
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json={"display_name": "Acme", **patch}, headers=fresh_auth(a.auth_user_id))
    assert r.status_code == 422
    assert field in json.dumps(r.json()["detail"])


def test_unknown_and_forged_fields_are_rejected(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    r = client.put(
        URL,
        json={"display_name": "Hijack", "employer_id": str(b.employer_id)},
        headers=fresh_auth(a.auth_user_id),
    )
    assert r.status_code == 422


# ------------------------------------------------------------------ re-authentication
def test_customer_visible_change_needs_a_recent_password_check(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    for headers in (bearer(a.auth_user_id), stale_auth(a.auth_user_id)):
        r = client.put(URL, json={"display_name": "New Name"}, headers=headers)
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "reauth_required"
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["display_name"] == "Acme"


def test_internal_only_changes_need_no_password_check(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(
        URL,
        json={
            "display_name": "Acme",
            "pan": "ABCDE1234F",
            "contact_person": "Asha",
            "website": "https://a.in",
        },
        headers=bearer(a.auth_user_id),
    )
    assert r.status_code == 200, r.text
    assert r.json()["pan"] == "ABCDE1234F"


def test_unchanged_save_is_a_noop_without_audit(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    r = client.put(URL, json={"display_name": "Acme"}, headers=bearer(a.auth_user_id))
    assert r.status_code == 200
    assert audit(admin_engine, a) == []


def audit(engine: Engine, t: Tenant) -> list[Any]:
    with engine.connect() as c:
        return list(
            c.execute(
                text(
                    "SELECT actor, action, details FROM audit_events "
                    "WHERE employer_id = :e AND entity_type = 'company_profile' ORDER BY created_at"
                ),
                {"e": t.employer_id},
            )
        )


def test_audit_records_field_names_only_never_values(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    client.put(URL, json=FULL, headers=fresh_auth(a.auth_user_id))
    rows = audit(admin_engine, a)
    assert len(rows) == 1
    assert rows[0].details["reauthenticated"] is True
    blob = json.dumps(rows[0].details)
    for secret in ("27ABCDE1234F1Z5", "ABCDE1234F", "9876543210", "Pune", "acme.example"):
        assert secret not in blob
    changes = client.get(URL, headers=bearer(a.auth_user_id)).json()["recent_changes"]
    assert "gstin" in changes[0]["fields"]


# ------------------------------------------------------------------ tenant isolation
def test_each_employer_only_sees_and_changes_its_own_profile(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    client.put(
        URL, json={"display_name": "Alpha Co", "city": "Pune"}, headers=fresh_auth(a.auth_user_id)
    )
    client.put(
        URL, json={"display_name": "Beta Co", "city": "Delhi"}, headers=fresh_auth(b.auth_user_id)
    )
    r = client.get(
        URL,
        params={"employer_id": str(b.employer_id)},
        headers={**bearer(a.auth_user_id), "X-Employer-Id": str(b.employer_id)},
    )
    assert (r.json()["display_name"], r.json()["city"]) == ("Alpha Co", "Pune")
    assert client.get(URL, headers=bearer(b.auth_user_id)).json()["city"] == "Delhi"


def test_rls_blocks_cross_tenant_reads_and_writes_on_the_table(
    make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    from app.core.db import tenant_session

    a, b = make_tenant("a"), make_tenant("b")
    with tenant_session(a.employer_id) as db:
        assert db.execute(text("SELECT count(*) FROM company_profiles")).scalar_one() == 1
        updated = db.execute(
            text("UPDATE company_profiles SET city = 'x' WHERE employer_id = :e RETURNING id"),
            {"e": b.employer_id},
        ).all()
        assert updated == []


# ------------------------------------------------------------------ logo
def test_logo_is_reencoded_downsized_stored_privately_and_served_to_its_owner(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    r = put_logo(client, fresh_auth(a.auth_user_id), plain((1600, 800)))
    assert r.status_code == 200, r.text
    assert r.json()["has_logo"] is True
    files = logo_files(storage_dir, a)
    assert len(files) == 1
    with Image.open(files[0]) as img:
        assert img.format == "PNG"
        assert max(img.size) == 512
    got = client.get(LOGO, headers=bearer(a.auth_user_id))
    assert got.status_code == 200 and got.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert got.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("fmt", ["JPEG", "WEBP"])
def test_jpeg_and_webp_logos_are_accepted(
    client: TestClient, make_tenant: MakeTenant, fmt: str
) -> None:
    a = make_tenant("a")
    assert put_logo(client, fresh_auth(a.auth_user_id), image(fmt)).status_code == 200


def test_logo_filename_is_never_trusted(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    put_logo(client, fresh_auth(a.auth_user_id), image(), name="../../etc/passwd.png")
    names = [p.name for p in logo_files(storage_dir, a)]
    assert len(names) == 1 and names[0].endswith(".png") and "passwd" not in names[0]


@pytest.mark.parametrize(
    ("data", "needle"),
    [
        (b"", "empty"),
        (b"not an image at all", "supported format"),
        (
            b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
            "supported format",
        ),
        (image("GIF"), "PNG, JPG or WebP"),
        (image("PNG", (40, 40)), "too small"),
        (b"\x89PNG\r\n\x1a\n" + b"0" * (2 * 1024 * 1024 + 10), "larger than 2 MB"),
    ],
)
def test_bad_logo_files_are_rejected_cleanly(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path, data: bytes, needle: str
) -> None:
    a = make_tenant("a")
    r = put_logo(client, fresh_auth(a.auth_user_id), data)
    assert r.status_code == 422
    assert needle in json.dumps(r.json()["detail"])
    assert not logo_files(storage_dir, a)


def test_animated_logo_is_rejected(client: TestClient, make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    frames = [Image.new("RGB", (100, 100), c) for c in ("red", "blue")]
    out = io.BytesIO()
    frames[0].save(out, format="WEBP", save_all=True, append_images=frames[1:])
    assert put_logo(client, fresh_auth(a.auth_user_id), out.getvalue()).status_code == 422


def test_logo_changes_need_a_recent_password_check(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    assert put_logo(client, bearer(a.auth_user_id), image()).status_code == 403
    assert client.delete(LOGO, headers=stale_auth(a.auth_user_id)).status_code == 403
    assert not logo_files(storage_dir, a)


def test_replacing_and_removing_a_logo_cleans_up_storage(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    h = fresh_auth(a.auth_user_id)
    put_logo(client, h, image())
    put_logo(client, h, image())
    assert len(logo_files(storage_dir, a)) == 1
    r = client.delete(LOGO, headers=h)
    assert r.status_code == 200 and r.json()["has_logo"] is False
    assert not logo_files(storage_dir, a)
    assert client.get(LOGO, headers=bearer(a.auth_user_id)).status_code == 404


def test_logo_upload_before_the_form_was_ever_saved_keeps_the_account_name(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    with admin_engine.connect() as c:
        c.execute(text("DELETE FROM company_profiles WHERE employer_id = :e"), {"e": a.employer_id})
    r = put_logo(client, fresh_auth(a.auth_user_id), image())
    assert r.status_code == 200
    assert (r.json()["display_name"], r.json()["has_logo"], r.json()["saved"]) == (
        "Employer a",
        True,
        True,
    )


def test_one_employer_cannot_read_anothers_logo(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    put_logo(client, fresh_auth(a.auth_user_id), image())
    assert client.get(LOGO, headers=bearer(b.auth_user_id)).status_code == 404


# ------------------------------------------------------------------ public page
def test_public_page_uses_the_company_profile_and_hides_internal_fields(
    client: TestClient, make_employer: MakeTenant, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, [{"customer_name": "Rahul", "amount_due": "100"}])
    configure(admin_engine, storage_dir, t, qr=qr_png())
    client.put(URL, json=FULL, headers=fresh_auth(t.auth_user_id))
    put_logo(client, fresh_auth(t.auth_user_id), image())
    _, token = page_token(client, t)
    r = client.get(f"/api/v1/public/pay/{token}")
    page = r.json()
    assert page["company_name"] == "Acme Traders"
    assert page["has_logo"] is True
    assert page["company_phone"] == "+919876543210"
    assert page["company_email"] == "accounts@acme.example"
    assert page["company_address"] == "12 MG Road, Pune, Maharashtra 411001"
    assert page["company_gstin"] == "27ABCDE1234F1Z5"
    assert not {"pan", "legal_name", "contact_person", "website", "company_pan"} & page.keys()
    for hidden in (
        "Asha",
        "Acme Holdings LLP",
        "https://acme.example",
    ):  # person, legal name, site
        assert hidden not in r.text, hidden
    logo = client.get(f"/api/v1/public/pay/{token}/logo")
    assert logo.status_code == 200 and logo.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_public_logo_and_contacts_disappear_when_not_configured_or_paid(
    client: TestClient, make_employer: MakeTenant, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, [{"customer_name": "Rahul", "amount_due": "100"}])
    configure(admin_engine, storage_dir, t)
    cid, token = page_token(client, t)
    assert client.get(f"/api/v1/public/pay/{token}/logo").status_code == 404
    client.put(URL, json=FULL, headers=fresh_auth(t.auth_user_id))
    put_logo(client, fresh_auth(t.auth_user_id), image())
    client.post(f"/api/v1/collections/{cid}/mark-paid", headers=bearer(t.auth_user_id))
    paid = client.get(f"/api/v1/public/pay/{token}").json()
    assert paid["state"] == "PAID" and paid["has_logo"] is True
    assert paid["company_phone"] is None and paid["company_gstin"] is None
    assert client.get(f"/api/v1/public/pay/{token}/logo").status_code == 200


def test_existing_links_survive_and_keep_the_name_after_the_move(
    client: TestClient, make_employer: MakeTenant, admin_engine: Engine, storage_dir: Path
) -> None:
    t = make_employer("a")
    add(client, t, [{"customer_name": "Rahul", "amount_due": "100"}])
    _, token = page_token(client, t)
    with admin_engine.connect() as c:  # legacy state: name only in payment_settings
        c.execute(text("DELETE FROM company_profiles WHERE employer_id = :e"), {"e": t.employer_id})
        c.execute(
            text(
                "INSERT INTO payment_settings (employer_id, display_name) VALUES (:e, 'Legacy Co')"
            ),
            {"e": t.employer_id},
        )
    assert client.get(f"/api/v1/public/pay/{token}").json()["company_name"] == "Legacy Co"


# ------------------------------------------------------------------ migration
def test_migration_moves_existing_display_names_into_company_profiles(
    admin_engine: Engine, make_tenant: MakeTenant
) -> None:
    cfg = alembic_config(get_settings().database_url)
    with admin_engine.connect() as c:
        c.execute(text("TRUNCATE employers CASCADE"))
    command.downgrade(cfg, "0002")
    try:
        with admin_engine.connect() as c:
            eids = []
            for i, name in enumerate(["  Old Name Co  ", "X", None]):
                eid = c.execute(
                    text(
                        "INSERT INTO employers (auth_user_id, name, email) "
                        "VALUES (gen_random_uuid(), :n, :m) RETURNING id"
                    ),
                    {"n": f"Employer {i}", "m": f"m{i}@example.test"},
                ).scalar_one()
                c.execute(
                    text(
                        "INSERT INTO payment_settings (employer_id, display_name) VALUES (:e, :n)"
                    ),
                    {"e": eid, "n": name},
                )
                eids.append(eid)
        command.upgrade(cfg, "head")
        with admin_engine.connect() as c:
            rows = {
                r.employer_id: r.display_name
                for r in c.execute(text("SELECT employer_id, display_name FROM company_profiles"))
            }
        assert rows == {eids[0]: "Old Name Co"}  # too-short or empty names are left to the fallback
    finally:
        command.upgrade(cfg, "head")
