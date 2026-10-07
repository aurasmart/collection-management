"""QR upload: authorisation, validation, private tenant-scoped storage, cleanup, rollback."""

from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import Engine, text

from app.storage.base import StorageError
from app.storage.local import LocalStorage
from app.storage.supabase import SupabaseStorage
from tests.conftest import Tenant, bearer, fresh_auth, stale_auth

MakeTenant = Callable[[str], Tenant]
URL = "/api/v1/settings/payment"
QR = f"{URL}/qr"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def image_bytes(fmt: str = "PNG", size: tuple[int, int] = (320, 320), mode: str = "RGB") -> bytes:
    img = Image.effect_noise(size, 80).convert(mode)
    out = io.BytesIO()
    img.save(out, format=fmt)
    return out.getvalue()


def upload(client: TestClient, headers: dict[str, str], data: bytes, name: str = "qr.png") -> Any:
    return client.put(QR, files={"file": (name, data, "image/png")}, headers=headers)


def objects(storage_dir: Path, tenant: Tenant) -> list[Path]:
    root = storage_dir / "qr" / str(tenant.employer_id) / "qr"
    return sorted(root.glob("*.png")) if root.exists() else []


# ------------------------------------------------------------------ authorisation
def test_upload_requires_authentication(client: TestClient) -> None:
    assert client.put(QR, files={"file": ("q.png", image_bytes(), "image/png")}).status_code == 401


def test_upload_requires_recent_password_confirmation(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    for headers in (bearer(a.auth_user_id), stale_auth(a.auth_user_id)):
        r = upload(client, headers, image_bytes())
        assert (r.status_code, r.json()["detail"]["code"]) == (403, "reauth_required")
    assert objects(storage_dir, a) == []


def test_delete_requires_recent_password_confirmation(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    assert client.delete(QR, headers=stale_auth(a.auth_user_id)).status_code == 403


# ------------------------------------------------------------------ happy path + privacy
def test_upload_stores_a_clean_png_privately_under_the_employer_prefix(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    r = upload(client, fresh_auth(a.auth_user_id), image_bytes("JPEG"), "photo.jpg")
    assert r.status_code == 200, r.text
    assert r.json()["has_qr"] is True
    stored = objects(storage_dir, a)
    assert len(stored) == 1
    assert stored[0].read_bytes().startswith(PNG_MAGIC)  # JPEG re-encoded to PNG
    with admin_engine.connect() as c:
        key = c.execute(
            text("SELECT qr_code_storage_key FROM payment_settings WHERE employer_id = :e"),
            {"e": a.employer_id},
        ).scalar_one()
    assert key.startswith(f"{a.employer_id}/qr/")
    # The API never hands the browser a storage URL or key.
    assert "storage" not in r.text.lower() and key not in r.text


def test_qr_is_served_only_through_the_authenticated_endpoint(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    assert upload(client, fresh_auth(a.auth_user_id), image_bytes()).status_code == 200
    assert client.get(QR).status_code == 401
    ok = client.get(QR, headers=bearer(a.auth_user_id))  # no recent auth needed to *read*
    assert ok.status_code == 200
    assert ok.headers["content-type"] == "image/png"
    assert ok.headers["cache-control"] == "private, no-store"
    assert ok.content.startswith(PNG_MAGIC)


def test_another_employer_cannot_read_or_remove_my_qr(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a, b = make_tenant("a"), make_tenant("b")
    upload(client, fresh_auth(a.auth_user_id), image_bytes())
    assert client.get(QR, headers=bearer(b.auth_user_id)).status_code == 404
    assert client.get(URL, headers=bearer(b.auth_user_id)).json()["has_qr"] is False
    client.delete(QR, headers=fresh_auth(b.auth_user_id))
    assert len(objects(storage_dir, a)) == 1  # A's file untouched
    assert client.get(QR, headers=bearer(a.auth_user_id)).status_code == 200


def test_no_qr_means_404(client: TestClient, make_tenant: MakeTenant) -> None:
    a = make_tenant("a")
    assert client.get(QR, headers=bearer(a.auth_user_id)).status_code == 404


# ------------------------------------------------------------------ file validation
def _animated_gif() -> bytes:
    frames = [Image.new("P", (320, 320), i) for i in (1, 2)]
    out = io.BytesIO()
    frames[0].save(out, format="GIF", save_all=True, append_images=frames[1:])
    return out.getvalue()


@pytest.mark.parametrize(
    ("data", "why"),
    [
        (b"", "empty"),
        (b"just some text, not an image", "not an image"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "svg"),
        (b"%PDF-1.7 fake", "pdf"),
        (image_bytes("PNG", (299, 400)), "too narrow"),
        (image_bytes("PNG", (400, 100)), "too short"),
        (image_bytes("PNG", (4200, 320), "L"), "too wide"),
        (image_bytes("GIF", (320, 320), "L"), "gif"),
        (_animated_gif(), "animated gif"),
        (image_bytes("BMP", (320, 320)), "bmp"),
        (PNG_MAGIC + b"truncated garbage", "corrupt png"),
        (b"\xff\xd8\xff\xe0 truncated jpeg", "corrupt jpeg"),
        (image_bytes("PNG", (320, 320)) + b"\0" * (2 * 1024 * 1024), "over 2 MB"),
    ],
)
def test_unsafe_or_unexpected_files_are_rejected(
    data: bytes, why: str, client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    r = upload(client, fresh_auth(a.auth_user_id), data, "evil.png")
    assert r.status_code == 422, why
    assert r.json()["detail"][0]["loc"][-1] == "qr"
    assert objects(storage_dir, a) == []
    assert client.get(URL, headers=bearer(a.auth_user_id)).json()["has_qr"] is False


def test_declared_content_type_and_extension_are_not_trusted(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    r = client.put(
        QR,
        files={"file": ("harmless.png", b"<html><script>1</script></html>", "image/png")},
        headers=fresh_auth(a.auth_user_id),
    )
    assert r.status_code == 422


# ------------------------------------------------------------------ replace / remove / enable rules
def test_replacing_deletes_the_old_object(
    client: TestClient, make_tenant: MakeTenant, storage_dir: Path
) -> None:
    a = make_tenant("a")
    h = fresh_auth(a.auth_user_id)
    upload(client, h, image_bytes())
    first = objects(storage_dir, a)
    upload(client, h, image_bytes(size=(400, 400)))
    second = objects(storage_dir, a)
    assert len(second) == 1 and second != first


def test_cannot_enable_qr_without_one_and_cannot_remove_while_enabled(
    client: TestClient, make_tenant: MakeTenant
) -> None:
    a = make_tenant("a")
    h = fresh_auth(a.auth_user_id)
    assert client.put(URL, json={"qr_enabled": True}, headers=h).status_code == 422
    upload(client, h, image_bytes())
    assert client.put(URL, json={"qr_enabled": True}, headers=h).status_code == 200
    r = client.delete(QR, headers=h)
    assert r.status_code == 422 and r.json()["detail"][0]["loc"][-1] == "qr_enabled"
    client.put(URL, json={"qr_enabled": False}, headers=h)
    assert client.delete(QR, headers=h).json()["has_qr"] is False
    assert client.get(QR, headers=bearer(a.auth_user_id)).status_code == 404


def test_qr_changes_are_audited_without_content(
    client: TestClient, make_tenant: MakeTenant, admin_engine: Engine
) -> None:
    a = make_tenant("a")
    upload(client, fresh_auth(a.auth_user_id), image_bytes())
    with admin_engine.connect() as c:
        details = c.execute(
            text(
                "SELECT details FROM audit_events "
                "WHERE employer_id=:e AND action='settings_changed'"
            ),
            {"e": a.employer_id},
        ).scalar_one()
    assert details["fields"] == ["qr_code"]
    assert details["reauthenticated"] is True


def test_failed_database_write_removes_the_new_object(
    make_tenant: MakeTenant, storage_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.main import create_app
    from app.modules.settings import service

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(service, "write_audit", boom)
    a = make_tenant("a")
    with TestClient(create_app(), raise_server_exceptions=False) as c:
        r = upload(c, fresh_auth(a.auth_user_id), image_bytes())
    assert r.status_code == 500
    assert objects(storage_dir, a) == []  # no orphan


# ------------------------------------------------------------------ storage implementations
def test_local_storage_blocks_path_traversal(tmp_path: Path) -> None:
    s = LocalStorage(tmp_path)
    s.put("qr", "emp/qr/a.png", b"x", "image/png")
    assert s.get("qr", "emp/qr/a.png") == b"x"
    with pytest.raises(StorageError):
        s.get("qr", "../../etc/passwd")
    s.delete("qr", "emp/qr/a.png")
    assert s.get("qr", "emp/qr/a.png") is None


def test_supabase_storage_uses_private_authenticated_endpoints() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, content=b"png-bytes")
        return httpx.Response(200, json={"Key": "ok"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    s = SupabaseStorage("https://proj.supabase.co/", "service-key-value", client=client)
    s.put("qr", "emp-1/qr/x.png", b"data", "image/png")
    assert s.get("qr", "emp-1/qr/x.png") == b"png-bytes"
    s.delete("qr", "emp-1/qr/x.png")
    for req in seen:
        assert str(req.url) == "https://proj.supabase.co/storage/v1/object/qr/emp-1/qr/x.png"
        assert "/public/" not in str(req.url)  # never the public-bucket route
        assert req.headers["authorization"] == "Bearer service-key-value"
    assert seen[0].headers["x-upsert"] == "true"
    assert seen[0].headers["content-type"] == "image/png"


@pytest.mark.parametrize(("status", "expected"), [(404, None), (400, None)])
def test_supabase_storage_missing_object_is_none(status: int, expected: None) -> None:
    client = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(status)))
    assert (
        SupabaseStorage("https://p.supabase.co", "k", client=client).get("qr", "a/b.png")
        is expected
    )


def test_supabase_storage_errors_do_not_leak_credentials() -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _r: httpx.Response(500, text="boom"))
    )
    s = SupabaseStorage("https://p.supabase.co", "super-secret-service-key", client=client)
    with pytest.raises(StorageError) as exc:
        s.put("qr", "a/b.png", b"x", "image/png")
    assert "super-secret-service-key" not in str(exc.value)
