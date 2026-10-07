"""Google Sheets: strict URL parsing, SSRF protection, public export, service-account access."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.modules.imports.gsheets import (
    GoogleSheetsClient,
    SheetRef,
    get_google_client,
    parse_sheet_url,
)
from app.modules.imports.model import ImportFileError
from tests.conftest import Tenant, bearer
from tests.import_helpers import GOOD, xlsx_sheets

MakeEmployer = Callable[[str], Tenant]
SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDe"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode()
PUBLIC_KEY = KEY.public_key()
SA_EMAIL = "collections@example-project.iam.gserviceaccount.com"


# ------------------------------------------------------------------ URL parsing
@pytest.mark.parametrize(
    "url",
    [
        f"https://docs.google.com/spreadsheets/d/{SID}/edit#gid=0",
        f"https://docs.google.com/spreadsheets/d/{SID}/edit?usp=sharing",
        f"https://docs.google.com/spreadsheets/d/{SID}",
        f"https://docs.google.com/spreadsheets/d/{SID}/htmlview",
        f"  https://docs.google.com/spreadsheets/d/{SID}/edit?gid=123#gid=123  ",
        f"https://docs.google.com:443/spreadsheets/d/{SID}/edit",
    ],
)
def test_real_sheet_links_give_only_the_spreadsheet_id(url: str) -> None:
    assert parse_sheet_url(url) == SheetRef(SID)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "not a url",
        f"http://docs.google.com/spreadsheets/d/{SID}/edit",  # not https
        f"https://docs.google.com.evil.example/spreadsheets/d/{SID}/edit",
        f"https://evil.example/docs.google.com/spreadsheets/d/{SID}/edit",
        f"https://docs.google.com@evil.example/spreadsheets/d/{SID}/edit",
        f"https://user:pass@docs.google.com/spreadsheets/d/{SID}/edit",
        f"https://docs.google.com:8443/spreadsheets/d/{SID}/edit",
        f"https://evil.example:443@docs.google.com/spreadsheets/d/{SID}/edit",
        f"https://drive.google.com/spreadsheets/d/{SID}/edit",
        f"https://sheets.googleapis.com/spreadsheets/d/{SID}/edit",
        f"https://DOCS.GOOGLE.COM.evil.example/spreadsheets/d/{SID}",
        "https://docs.google.com/document/d/" + SID + "/edit",
        "https://docs.google.com/spreadsheets/d/short/edit",
        f"https://docs.google.com/spreadsheets/d/{SID}x/../../etc/passwd",
        f"https://docs.google.com/spreadsheets/d/{SID}%2f..%2f..",
        f"https://docs.google.com/spreadsheets/d/{'a' * 200}/edit",
        "https://169.254.169.254/spreadsheets/d/" + SID,
        "https://localhost/spreadsheets/d/" + SID,
        "http://127.0.0.1:8000/spreadsheets/d/" + SID,
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://docs.google.com/spreadsheets/d/" + SID,
        f"https://docs.google.com/spreadsheets/d/{SID}/edit\nHost: evil.example",
        "https://docs.google.com/spreadsheets/d/" + SID + "/edit " + "x" * 3000,
        "https://[::1]/spreadsheets/d/" + SID,
    ],
)
def test_anything_that_is_not_a_google_sheets_link_is_refused(url: str) -> None:
    with pytest.raises(ImportFileError, match="Google Sheets link"):
        parse_sheet_url(url)


# ------------------------------------------------------------------ helpers
def settings_with(**over: Any) -> Settings:
    return get_settings().model_copy(update=over)


def private_settings() -> Settings:
    return settings_with(
        google_service_account_email=SA_EMAIL, google_service_account_private_key=PRIVATE_PEM
    )


class Recorder:
    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self.requests: list[httpx.Request] = []
        self._handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)

    def client(self, settings: Settings) -> GoogleSheetsClient:
        http = httpx.Client(transport=httpx.MockTransport(self), follow_redirects=False)
        return GoogleSheetsClient(settings, http)

    @property
    def hosts(self) -> set[str]:
        return {r.url.host for r in self.requests}


def sheet_bytes(sheets: dict[str, list[list[Any]]] | None = None) -> bytes:
    return xlsx_sheets(sheets or {"October": GOOD, "Notes": [["x"]]})


# ------------------------------------------------------------------ public sheets
def test_a_public_sheet_is_read_through_googles_own_export_only() -> None:
    rec = Recorder(
        lambda r: httpx.Response(200, content=sheet_bytes(), headers={"content-type": XLSX})
    )
    wb = rec.client(get_settings()).load(SheetRef(SID))
    assert wb.kind == "google_sheets"
    assert [s.name for s in wb.sheets] == ["October", "Notes"]  # every worksheet, for the picker
    (req,) = rec.requests
    assert (req.url.scheme, req.url.host, req.url.path) == (
        "https", "docs.google.com", f"/spreadsheets/d/{SID}/export",
    )  # fmt: skip
    assert parse_qs(req.url.query.decode()) == {"format": ["xlsx"]}


def test_the_pasted_url_is_never_fetched_only_its_id_is_used(
    client: TestClient, make_employer: MakeEmployer
) -> None:
    rec = Recorder(
        lambda r: httpx.Response(200, content=sheet_bytes(), headers={"content-type": XLSX})
    )
    client.app.dependency_overrides[get_google_client] = lambda: rec.client(get_settings())  # type: ignore[attr-defined]
    try:
        t = make_employer("a")
        url = f"https://docs.google.com/spreadsheets/d/{SID}/edit?next=https://evil.example/steal#gid=0"
        r = client.post(
            "/api/v1/imports/analyze", data={"sheet_url": url}, headers=bearer(t.auth_user_id)
        )
        assert r.status_code == 200, r.text
        assert rec.hosts == {"docs.google.com"}
        assert all("evil.example" not in str(q.url) for q in rec.requests)
        assert r.json()["source"] == "google_sheets"
        assert [s["name"] for s in r.json()["sheets"]] == ["October", "Notes"]
        assert r.json()["sheet"] == 0  # the worksheet that looks like customers
    finally:
        client.app.dependency_overrides.clear()  # type: ignore[attr-defined]


def test_google_redirects_to_its_own_content_host_are_followed() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.host == "docs.google.com":
            return httpx.Response(
                307,
                headers={"location": "https://doc-0c-abc-sheets.googleusercontent.com/export/x"},
            )
        return httpx.Response(200, content=sheet_bytes(), headers={"content-type": XLSX})

    rec = Recorder(handler)
    wb = rec.client(get_settings()).load(SheetRef(SID))
    assert wb.sheets
    assert rec.hosts == {"docs.google.com", "doc-0c-abc-sheets.googleusercontent.com"}


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/steal",
        "http://169.254.169.254/latest/meta-data/",
        "https://docs.google.com.evil.example/x",
        "https://evilgoogleusercontent.com/x",
        "http://doc.googleusercontent.com/x",  # plain http
        "file:///etc/passwd",
        "https://localhost/admin",
    ],
)
def test_a_redirect_to_anywhere_else_is_never_followed(location: str) -> None:
    rec = Recorder(lambda r: httpx.Response(302, headers={"location": location}))
    with pytest.raises(ImportFileError, match="couldn't open this sheet"):
        rec.client(get_settings()).load(SheetRef(SID))
    assert rec.hosts == {"docs.google.com"}  # the foreign address was never contacted


def test_a_login_page_means_the_sheet_is_private() -> None:
    rec = Recorder(
        lambda r: httpx.Response(
            200, content=b"<html>Sign in</html>", headers={"content-type": "text/html"}
        )
    )
    with pytest.raises(ImportFileError, match="Importing private sheets isn't set up"):
        rec.client(get_settings()).load(SheetRef(SID))


def test_endless_redirects_stop() -> None:
    rec = Recorder(
        lambda r: httpx.Response(
            302, headers={"location": f"https://docs.google.com/loop/{len(rec.requests)}"}
        )
    )
    with pytest.raises(ImportFileError, match="couldn't open this sheet"):
        rec.client(get_settings()).load(SheetRef(SID))
    assert len(rec.requests) <= 4


def test_an_oversized_export_is_refused() -> None:
    big = b"PK\x03\x04" + b"0" * (5 * 1024 * 1024 + 10)
    rec = Recorder(lambda r: httpx.Response(200, content=big, headers={"content-type": XLSX}))
    with pytest.raises(ImportFileError, match="larger than 5 MB"):
        rec.client(get_settings()).load(SheetRef(SID))


def test_a_network_failure_is_explained() -> None:
    def boom(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with pytest.raises(ImportFileError, match="couldn't reach Google Sheets"):
        Recorder(boom).client(get_settings()).load(SheetRef(SID))


# ------------------------------------------------------------------ private sheets
def private_handler(*, allowed: bool = True) -> Callable[[httpx.Request], httpx.Response]:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.host == "docs.google.com":
            return httpx.Response(
                302, headers={"location": "https://accounts.google.com/ServiceLogin"}
            )
        if r.url.host == "oauth2.googleapis.com":
            return httpx.Response(
                200, json={"access_token": "ya29.fake-access-token", "expires_in": 3600}
            )
        assert r.headers["authorization"] == "Bearer ya29.fake-access-token"
        if not allowed:
            return httpx.Response(403, json={"error": {"status": "PERMISSION_DENIED"}})
        if r.url.path.endswith("values:batchGet"):
            return httpx.Response(
                200,
                json={
                    "valueRanges": [
                        {
                            "values": [
                                ["Party Name", "Outstanding"],
                                ["Rahul", "₹15,000"],
                                ["Priya", "2,500.50"],
                            ]
                        },
                        {"values": [["notes"]]},
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "sheets": [
                    {"properties": {"sheetId": 0, "title": "Dues", "index": 0}},
                    {"properties": {"sheetId": 7, "title": "Bob's notes", "index": 1}},
                    {"properties": {"sheetId": 9, "title": "Old", "index": 2, "hidden": True}},
                ]
            },
        )

    return handler


def test_a_private_sheet_is_read_with_the_service_account() -> None:
    rec = Recorder(private_handler())
    wb = rec.client(private_settings()).load(SheetRef(SID))
    assert [s.name for s in wb.sheets] == ["Dues", "Bob's notes"]  # hidden sheet skipped
    assert wb.sheets[0].rows[1] == ["Rahul", "₹15,000"]
    assert rec.hosts == {"docs.google.com", "oauth2.googleapis.com", "sheets.googleapis.com"}
    token_req = next(r for r in rec.requests if r.url.host == "oauth2.googleapis.com")
    form = parse_qs(token_req.content.decode())
    assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
    claims = jwt.decode(
        form["assertion"][0], PUBLIC_KEY, algorithms=["RS256"],
        audience="https://oauth2.googleapis.com/token",
    )  # fmt: skip
    assert claims["iss"] == SA_EMAIL
    assert claims["scope"] == "https://www.googleapis.com/auth/spreadsheets.readonly"  # read-only
    assert claims["exp"] - claims["iat"] <= 3600
    ranges = parse_qs(
        urlparse(str(next(r for r in rec.requests if "batchGet" in r.url.path).url)).query
    )
    assert "'Bob''s notes'!A1:BH2060" in ranges["ranges"]  # quote in a title is escaped
    assert ranges["valueRenderOption"] == ["FORMATTED_VALUE"]


def test_the_access_token_is_reused_not_requested_for_every_call() -> None:
    rec = Recorder(private_handler())
    c = rec.client(private_settings())
    c.load(SheetRef(SID))
    c.load(SheetRef(SID))
    assert sum(1 for r in rec.requests if r.url.host == "oauth2.googleapis.com") == 1


def test_a_sheet_not_shared_with_the_service_account_says_exactly_who_to_share_with() -> None:
    rec = Recorder(private_handler(allowed=False))
    with pytest.raises(ImportFileError) as err:
        rec.client(private_settings()).load(SheetRef(SID))
    assert SA_EMAIL in str(err.value) and "as Viewer" in str(err.value)


def test_a_failing_google_token_exchange_is_explained_without_leaking_details() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.host == "docs.google.com":
            return httpx.Response(302, headers={"location": "https://accounts.google.com/x"})
        return httpx.Response(400, json={"error": "invalid_grant", "private": PRIVATE_PEM[:20]})

    with pytest.raises(ImportFileError, match="isn't working on this server") as err:
        Recorder(handler).client(private_settings()).load(SheetRef(SID))
    assert "invalid_grant" not in str(err.value) and "PRIVATE" not in str(err.value)


def test_the_private_key_never_appears_in_any_outgoing_request() -> None:
    rec = Recorder(private_handler())
    rec.client(private_settings()).load(SheetRef(SID))
    for r in rec.requests:
        assert "PRIVATE KEY" not in str(r.url) + r.content.decode() + str(dict(r.headers))


def test_a_one_sided_service_account_configuration_is_rejected() -> None:
    with pytest.raises(ValueError, match="BOTH GOOGLE_SERVICE_ACCOUNT_EMAIL"):
        Settings(
            _env_file=None,
            database_url="postgresql://x/y",
            token_enc_key=get_settings().token_enc_key,
            token_hmac_secret=get_settings().token_hmac_secret,
            google_service_account_email=SA_EMAIL,
        )


# ------------------------------------------------------------------ API
@pytest.fixture
def google_override(client: TestClient) -> Iterator[Callable[[GoogleSheetsClient], None]]:
    def install(g: GoogleSheetsClient) -> None:
        client.app.dependency_overrides[get_google_client] = lambda: g  # type: ignore[attr-defined]

    yield install
    client.app.dependency_overrides.clear()  # type: ignore[attr-defined]


def test_the_ui_can_ask_whether_private_sheets_are_set_up(
    client: TestClient,
    make_employer: MakeEmployer,
    google_override: Callable[[GoogleSheetsClient], None],
) -> None:
    t = make_employer("a")
    h = bearer(t.auth_user_id)
    google_override(Recorder(private_handler()).client(get_settings()))
    assert client.get("/api/v1/imports/google-sheets", headers=h).json() == {
        "private_access": False, "service_account_email": None,
    }  # fmt: skip
    google_override(Recorder(private_handler()).client(private_settings()))
    body = client.get("/api/v1/imports/google-sheets", headers=h).json()
    assert body == {"private_access": True, "service_account_email": SA_EMAIL}
    assert "PRIVATE" not in str(body)


@pytest.mark.parametrize(
    "url", ["https://evil.example/x", "http://127.0.0.1/spreadsheets/d/" + SID, "nope"]
)
def test_the_api_refuses_non_google_links_before_any_request_is_made(
    client: TestClient,
    make_employer: MakeEmployer,
    google_override: Callable[[GoogleSheetsClient], None],
    url: str,
) -> None:
    t = make_employer("a")
    rec = Recorder(lambda r: httpx.Response(200))
    google_override(rec.client(get_settings()))
    for endpoint in ("analyze", "preview"):
        r = client.post(
            f"/api/v1/imports/{endpoint}", data={"sheet_url": url}, headers=bearer(t.auth_user_id)
        )
        assert r.status_code == 422 and "Google Sheets link" in r.json()["detail"]
    assert rec.requests == []


def test_preview_a_google_sheet_with_a_chosen_worksheet(
    client: TestClient,
    make_employer: MakeEmployer,
    google_override: Callable[[GoogleSheetsClient], None],
) -> None:
    t = make_employer("a")
    data = xlsx_sheets(
        {
            "Summary": [["Total", 1]],
            "Dues": [["Party", "Outstanding"], ["Rahul", 100], ["Priya", 200]],
        }
    )
    rec = Recorder(lambda r: httpx.Response(200, content=data, headers={"content-type": XLSX}))
    google_override(rec.client(get_settings()))
    url = f"https://docs.google.com/spreadsheets/d/{SID}/edit"
    r = client.post(
        "/api/v1/imports/preview",
        data={"sheet_url": url, "sheet": "1"},
        headers=bearer(t.auth_user_id),
    )
    assert r.status_code == 200, r.text
    assert [x["customer_name"] for x in r.json()["rows"]] == ["Rahul", "Priya"]
