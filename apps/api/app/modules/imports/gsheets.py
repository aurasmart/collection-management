"""Google Sheets as an import source.

SECURITY: the pasted URL is only ever PARSED, never fetched. We extract the spreadsheet ID (a
strict pattern) and build every request ourselves against Google's own endpoints from settings.
Redirects are followed manually and only to Google-owned hosts, so a user can never make the
server contact an arbitrary address (SSRF).

Access:
  1. Public / "anyone with the link" sheets: Google's xlsx export, no credentials.
  2. Private sheets: the employer shares the sheet with our service account (Viewer). The
     private key lives only in backend settings. No OAuth tokens are stored.
"""

from __future__ import annotations

import io
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import jwt

from app.core.config import Settings
from app.modules.imports.model import (
    MAX_COLUMNS,
    MAX_FILE_BYTES,
    MAX_SHEETS,
    ImportFileError,
    Sheet,
    Workbook,
)
from app.modules.imports.readers import SCAN_ROWS, read_xlsx

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,100}$")
_PATH_RE = re.compile(r"^/spreadsheets/d/([A-Za-z0-9_-]{20,100})(?:/|$)")
_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"
_TIMEOUT = httpx.Timeout(20.0, connect=8.0)
_MAX_HOPS = 4
BAD_URL = (
    "That doesn't look like a Google Sheets link. Copy the address from your browser while the "
    "sheet is open, like https://docs.google.com/spreadsheets/d/…/edit"
)


@dataclass(frozen=True)
class SheetRef:
    spreadsheet_id: str


def parse_sheet_url(url: str) -> SheetRef:
    """Accept only a real Google Sheets address, and keep nothing but the spreadsheet ID."""
    candidate = (url or "").strip()
    if not candidate or len(candidate) > 2000 or re.search(r"[\s\x00-\x1f]", candidate):
        raise ImportFileError(BAD_URL)
    try:
        parsed = urlparse(candidate)
        host, port, user = parsed.hostname, parsed.port, parsed.username
    except ValueError:
        raise ImportFileError(BAD_URL) from None
    if parsed.scheme != "https" or host != "docs.google.com" or port not in (None, 443) or user:
        raise ImportFileError(BAD_URL)
    m = _PATH_RE.match(parsed.path)
    if not m or ".." in parsed.path or "%" in parsed.path or "\\" in parsed.path:
        raise ImportFileError(BAD_URL)
    return SheetRef(m.group(1))


class GoogleSheetsClient:
    def __init__(self, settings: Settings, http: httpx.Client | None = None) -> None:
        self._s = settings
        self._http = http or httpx.Client(timeout=_TIMEOUT, follow_redirects=False)
        self._docs = settings.google_docs_base_url.rstrip("/")
        self._api = settings.google_sheets_api_base_url.rstrip("/")
        self._token_url = settings.google_token_url
        self._token: tuple[str, float] | None = None

    # -- public information for the UI -----------------------------------------------------
    @property
    def private_access(self) -> bool:
        return bool(
            self._s.google_service_account_email and self._s.google_service_account_private_key
        )

    @property
    def service_account_email(self) -> str | None:
        return self._s.google_service_account_email

    # -- the one entry point ---------------------------------------------------------------
    def load(self, ref: SheetRef) -> Workbook:
        data = self._public_xlsx(ref.spreadsheet_id)
        if data is not None:
            wb = read_xlsx(data)
            return Workbook("google_sheets", wb.sheets, notes=wb.notes)
        if self.private_access:
            return self._private(ref)
        raise ImportFileError(self._not_shared_message(configured=False))

    def _not_shared_message(self, *, configured: bool) -> str:
        if configured and self.service_account_email:
            return (
                "We couldn't open this sheet. To import a private Google Sheet, share the sheet "
                f"with our Google service account ({self.service_account_email}) as Viewer, "
                "then try again."
            )
        return (
            "We couldn't open this sheet. Make sure link sharing is on (anyone with the link can "
            "view). Importing private sheets isn't set up on this server."
        )

    # -- public sheets ---------------------------------------------------------------------
    def _origin_ok(self, url: str, base: str) -> bool:
        u, b = urlparse(url), urlparse(base)
        if (u.scheme, u.hostname, u.port or _default_port(u.scheme)) == (
            b.scheme,
            b.hostname,
            b.port or _default_port(b.scheme),
        ):
            return True
        # Google serves the export from a *.googleusercontent.com host after a redirect.
        return (
            u.scheme == "https"
            and (u.hostname or "").endswith(".googleusercontent.com")
            and b.hostname == "docs.google.com"
        )

    def _public_xlsx(self, sheet_id: str) -> bytes | None:
        url = f"{self._docs}/spreadsheets/d/{quote(sheet_id, safe='')}/export?format=xlsx"
        try:
            for _ in range(_MAX_HOPS):
                with self._http.stream("GET", url, headers={"Accept": "*/*"}) as r:
                    if r.is_redirect:
                        nxt = str(r.headers.get("location", ""))
                        url = str(httpx.URL(url).join(nxt))
                        if not self._origin_ok(url, self._docs):
                            return None  # a login page or anything not Google-owned: not public
                        continue
                    ctype = r.headers.get("content-type", "")
                    if r.status_code != 200 or "spreadsheetml" not in ctype:
                        return None
                    return _read_limited(r)
        except httpx.HTTPError:
            raise ImportFileError(
                "We couldn't reach Google Sheets right now. Please try again in a moment."
            ) from None
        return None

    # -- private sheets (service account) --------------------------------------------------
    def _access_token(self) -> str:
        if self._token and self._token[1] > time.time() + 60:
            return self._token[0]
        now = int(time.time())
        key = (self._s.google_service_account_private_key or "").replace("\\n", "\n")
        assertion = jwt.encode(
            {
                "iss": self._s.google_service_account_email,
                "scope": _SCOPE,
                "aud": self._token_url,
                "iat": now,
                "exp": now + 3600,
            },
            key,
            algorithm="RS256",
        )
        resp = self._http.post(
            self._token_url,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
        )
        if resp.status_code != 200:
            raise ImportFileError("Google Sheets access isn't working on this server right now.")
        body = resp.json()
        self._token = (str(body["access_token"]), now + int(body.get("expires_in", 3600)))
        return self._token[0]

    def _private(self, ref: SheetRef) -> Workbook:
        try:
            headers = {"Authorization": f"Bearer {self._access_token()}"}
            sid = quote(ref.spreadsheet_id, safe="")
            meta = self._http.get(
                f"{self._api}/v4/spreadsheets/{sid}",
                params={"fields": "sheets.properties(sheetId,title,index,hidden)"},
                headers=headers,
            )
            if meta.status_code in (401, 403, 404):
                raise ImportFileError(self._not_shared_message(configured=True))
            if meta.status_code != 200:
                raise ImportFileError("Google Sheets couldn't be read right now. Please try again.")
            props = [
                s["properties"]
                for s in meta.json().get("sheets", [])
                if not s["properties"].get("hidden")
            ][:MAX_SHEETS]
            if not props:
                raise ImportFileError("We couldn't find any data in this sheet.")
            ranges = [
                f"'{p['title'].replace(chr(39), chr(39) * 2)}'!A1:BH{SCAN_ROWS}" for p in props
            ]
            query: list[tuple[str, str | int | float | bool | None]] = [
                ("ranges", r) for r in ranges
            ]
            query.append(("valueRenderOption", "FORMATTED_VALUE"))
            vals = self._http.get(
                f"{self._api}/v4/spreadsheets/{sid}/values:batchGet",
                params=query,
                headers=headers,
            )
            if vals.status_code != 200:
                raise ImportFileError("Google Sheets couldn't be read right now. Please try again.")
            sheets = []
            for p, vr in zip(props, vals.json().get("valueRanges", []), strict=False):
                rows: list[list[Any]] = [
                    [c if c != "" else None for c in r[:MAX_COLUMNS]] for r in vr.get("values", [])
                ]
                if rows:
                    sheets.append(Sheet(str(p["title"]), rows))
        except httpx.HTTPError:
            raise ImportFileError(
                "We couldn't reach Google Sheets right now. Please try again in a moment."
            ) from None
        if not sheets:
            raise ImportFileError("We couldn't find any data in this sheet.")
        return Workbook("google_sheets", sheets)


def _default_port(scheme: str | None) -> int:
    return 443 if scheme == "https" else 80


def _read_limited(r: httpx.Response) -> bytes:
    buf = io.BytesIO()
    for chunk in r.iter_bytes():
        buf.write(chunk)
        if buf.tell() > MAX_FILE_BYTES:
            raise ImportFileError("This sheet is larger than 5 MB. Split it and import in parts.")
    return buf.getvalue()


def get_google_client() -> GoogleSheetsClient:
    from app.core.config import get_settings

    return GoogleSheetsClient(get_settings())
