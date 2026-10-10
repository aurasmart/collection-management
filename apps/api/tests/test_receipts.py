"""Payment receipts on collections and the petty-cash entries (ADR 0008)."""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.modules.imports.ocr import OcrUnavailable
from tests.conftest import Tenant, bearer
from tests.test_collections import ROWS, add, first_id

MakeEmployer = Callable[[str], Tenant]

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
SAMPLE_TEXT = """\
Reference ID 2559007396
6 Oct '26, 9:47 PM
Payment to optimaprojectors
Amount ₹1,62,840.00
Payment from 5915 0500 0085
Remarks amruppaporter
"""


def png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (200, 120), (10, 120, 60)).save(out, format="PNG")
    return out.getvalue()


def receipt_objects(storage_dir: Path, t: Tenant) -> list[Path]:
    root = storage_dir / "receipts" / str(t.employer_id)
    return [p for p in root.rglob("*") if p.is_file()] if root.exists() else []


def put_receipt(client: TestClient, t: Tenant, cid: str, data: bytes, name: str = "r.png") -> Any:
    return client.put(
        f"/api/v1/collections/{cid}/receipt",
        files={"file": (name, data, "application/octet-stream")},
        headers=bearer(t.auth_user_id),
    )


def one_collection(client: TestClient, t: Tenant) -> str:
    add(client, t, ROWS)
    return first_id(client, t, "Rahul")


def test_receipt_needs_sign_in(client: TestClient) -> None:
    cid = "00000000-0000-0000-0000-000000000001"
    assert client.get(f"/api/v1/collections/{cid}/receipt").status_code in (401, 403)
    assert client.get("/api/v1/petty-cash").status_code in (401, 403)


def test_attach_view_replace_and_remove_a_collection_receipt(
    client: TestClient, make_employer: MakeEmployer, storage_dir: Path
) -> None:
    t = make_employer("a")
    cid = one_collection(client, t)
    h = bearer(t.auth_user_id)
    assert client.get(f"/api/v1/collections/{cid}", headers=h).json()["has_receipt"] is False
    assert client.get(f"/api/v1/collections/{cid}/receipt", headers=h).status_code == 404

    r = put_receipt(client, t, cid, png())
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["has_receipt"] is True
    assert detail["receipt_content_type"] == "image/png" and detail["receipt_name"] == "r.png"
    got = client.get(f"/api/v1/collections/{cid}/receipt", headers=h)
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert got.content == png()
    assert len(receipt_objects(storage_dir, t)) == 1

    assert put_receipt(client, t, cid, PDF, "stmt.pdf").json()["receipt_content_type"] == (
        "application/pdf"
    )
    assert len(receipt_objects(storage_dir, t)) == 1  # the replaced file is gone

    assert client.delete(f"/api/v1/collections/{cid}/receipt", headers=h).status_code == 200
    assert client.get(f"/api/v1/collections/{cid}", headers=h).json()["has_receipt"] is False
    assert receipt_objects(storage_dir, t) == []


def test_marking_paid_does_not_need_a_receipt(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    t = make_employer("a")
    cid = one_collection(client, t)
    r = client.post(f"/api/v1/collections/{cid}/mark-paid", headers=bearer(t.auth_user_id))
    assert r.status_code == 200 and r.json()["status"] == "PAID"


@pytest.mark.parametrize(
    "data", [b"", b"just text", b"MZ\x90\x00 not an image", b"%PNG fake"], ids=str
)
def test_receipt_rejects_other_file_types(
    client: TestClient, make_employer: MakeEmployer, data: bytes
) -> None:
    t = make_employer("a")
    cid = one_collection(client, t)
    assert put_receipt(client, t, cid, data).status_code == 422


def test_receipt_rejects_files_over_5_mb(client: TestClient, make_employer: MakeEmployer) -> None:
    t = make_employer("a")
    cid = one_collection(client, t)
    assert put_receipt(client, t, cid, PDF + b"0" * (5 * 1024 * 1024)).status_code == 422


def test_receipts_are_private_to_their_employer(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    a, b = make_employer("a"), make_employer("b")
    cid = one_collection(client, a)
    assert put_receipt(client, a, cid, png()).status_code == 200
    hb = bearer(b.auth_user_id)
    assert client.get(f"/api/v1/collections/{cid}/receipt", headers=hb).status_code == 404
    assert client.delete(f"/api/v1/collections/{cid}/receipt", headers=hb).status_code == 404
    assert put_receipt(client, b, cid, png()).status_code == 404


def test_deleting_a_customer_removes_its_receipt_file(
    client: TestClient, make_employer: MakeEmployer, storage_dir: Path
) -> None:
    t = make_employer("a")
    cid = one_collection(client, t)
    put_receipt(client, t, cid, png())
    assert len(receipt_objects(storage_dir, t)) == 1
    assert (
        client.delete(f"/api/v1/collections/{cid}", headers=bearer(t.auth_user_id)).status_code
        == 204
    )
    assert receipt_objects(storage_dir, t) == []


# ------------------------------------------------------------------ petty cash


def extract(client: TestClient, t: Tenant, data: bytes) -> Any:
    return client.post(
        "/api/v1/petty-cash/extract",
        files={"file": ("r.png", data, "image/png")},
        headers=bearer(t.auth_user_id),
    )


def save(client: TestClient, t: Tenant, fields: dict[str, Any], data: bytes | None = None) -> Any:
    return client.post(
        "/api/v1/petty-cash",
        data={"fields": json.dumps(fields)},
        files={"file": ("r.png", data or png(), "image/png")},
        headers=bearer(t.auth_user_id),
    )


FIELDS = {
    "transaction_id": "2559007396",
    "txn_date": "2026-10-06",
    "payment_to": "optimaprojectors",
    "payment_from": "LATIGID ENGINEERING PRIVATE LIMITED",
    "remarks": "amruppaporter",
    "amount": "1,62,840.00",
}


def test_extract_proposes_fields_and_saves_nothing(
    client: TestClient, make_employer: MakeEmployer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.modules.petty_cash.files.receipt_text", lambda d, c: SAMPLE_TEXT)
    t = make_employer("a")
    r = extract(client, t, png())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["transaction_id"] == "2559007396" and body["txn_date"] == "2026-10-06"
    assert body["amount"] == "162840.00" and body["remarks"] == "amruppaporter"
    assert body["text_read"] is True and body["duplicate"] is False
    listing = client.get("/api/v1/petty-cash", headers=bearer(t.auth_user_id)).json()
    assert listing["total"] == 0


def test_extract_without_ocr_returns_an_empty_form(
    client: TestClient, make_employer: MakeEmployer, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unavailable(data: bytes, content_type: str) -> str:
        raise OcrUnavailable("off")

    monkeypatch.setattr("app.modules.petty_cash.files.receipt_text", unavailable)
    body = extract(client, make_employer("a"), png()).json()
    assert body["text_read"] is False and body["found"] == [] and body["amount"] is None


def test_extract_rejects_a_non_receipt_file(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    assert extract(client, make_employer("a"), b"hello").status_code == 422


def test_save_list_edit_view_and_delete_an_entry(
    client: TestClient, make_employer: MakeEmployer, storage_dir: Path
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    r = save(client, t, FIELDS)
    assert r.status_code == 201, r.text
    entry = r.json()
    assert entry["amount"] == "162840.00" and entry["content_type"] == "image/png"
    assert "storage_key" not in entry
    assert len(receipt_objects(storage_dir, t)) == 1

    listing = client.get("/api/v1/petty-cash", headers=h).json()
    assert listing["total"] == 1 and listing["total_amount"] == "162840.00"
    assert client.get("/api/v1/petty-cash", params={"q": "optima"}, headers=h).json()["total"] == 1
    assert client.get("/api/v1/petty-cash", params={"q": "zzz"}, headers=h).json()["total"] == 0

    eid = entry["id"]
    edited = client.put(
        f"/api/v1/petty-cash/{eid}", json={**FIELDS, "amount": "100", "remarks": ""}, headers=h
    )
    assert edited.status_code == 200 and edited.json()["amount"] == "100.00"
    assert edited.json()["remarks"] is None
    assert client.get(f"/api/v1/petty-cash/{eid}/receipt", headers=h).content == png()

    assert client.delete(f"/api/v1/petty-cash/{eid}", headers=h).status_code == 204
    assert client.get(f"/api/v1/petty-cash/{eid}", headers=h).status_code == 404
    assert receipt_objects(storage_dir, t) == []


def test_extract_flags_a_duplicate_transaction_id(
    client: TestClient, make_employer: MakeEmployer, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.modules.petty_cash.files.receipt_text", lambda d, c: SAMPLE_TEXT)
    t = make_employer("a")
    assert save(client, t, FIELDS).status_code == 201
    assert extract(client, t, png()).json()["duplicate"] is True


@pytest.mark.parametrize(
    "patch",
    [{"amount": ""}, {"amount": "abc"}, {"amount": "0"}, {"amount": "-5"}, {"amount": "1.234"},
     {"txn_date": "not-a-date"}],
)  # fmt: skip
def test_save_validates_the_reviewed_fields(
    client: TestClient, make_employer: MakeEmployer, patch: dict[str, str]
) -> None:
    assert save(client, make_employer("a"), {**FIELDS, **patch}).status_code == 422


def test_a_failed_save_leaves_no_file_behind(
    client: TestClient, make_employer: MakeEmployer, storage_dir: Path
) -> None:
    t = make_employer("a")
    assert save(client, t, {**FIELDS, "amount": "0"}).status_code == 422
    assert save(client, t, FIELDS, data=b"not an image").status_code == 422
    assert receipt_objects(storage_dir, t) == []


def test_petty_cash_is_private_to_its_employer(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    a, b = make_employer("a"), make_employer("b")
    eid = save(client, a, FIELDS).json()["id"]
    hb = bearer(b.auth_user_id)
    assert client.get("/api/v1/petty-cash", headers=hb).json()["total"] == 0
    assert client.get(f"/api/v1/petty-cash/{eid}", headers=hb).status_code == 404
    assert client.get(f"/api/v1/petty-cash/{eid}/receipt", headers=hb).status_code == 404
    assert client.put(f"/api/v1/petty-cash/{eid}", json=FIELDS, headers=hb).status_code == 404
    assert client.delete(f"/api/v1/petty-cash/{eid}", headers=hb).status_code == 404
