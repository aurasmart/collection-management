"""Supabase Storage (private buckets) over its REST API using the backend-only service key."""

from __future__ import annotations

from urllib.parse import quote

import httpx

from app.storage.base import StorageError


class SupabaseStorage:
    def __init__(
        self, base_url: str, service_key: str, *, client: httpx.Client | None = None
    ) -> None:
        self._base = base_url.rstrip("/") + "/storage/v1/object"
        self._headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
        self._client = client or httpx.Client(timeout=15.0)

    def _url(self, bucket: str, key: str) -> str:
        return f"{self._base}/{quote(bucket, safe='')}/{quote(key, safe='/')}"

    def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        resp = self._client.post(
            self._url(bucket, key),
            content=data,
            headers={**self._headers, "Content-Type": content_type, "x-upsert": "true"},
        )
        if resp.status_code >= 300:
            raise StorageError(f"upload failed ({resp.status_code}): {_reason(resp)}")

    def get(self, bucket: str, key: str) -> bytes | None:
        # Authenticated endpoint (not /public/): works for private buckets with the service key.
        resp = self._client.get(self._url(bucket, key), headers=self._headers)
        if resp.status_code in (400, 404):
            return None
        if resp.status_code >= 300:
            raise StorageError(f"download failed ({resp.status_code})")
        return resp.content

    def delete(self, bucket: str, key: str) -> None:
        resp = self._client.delete(self._url(bucket, key), headers=self._headers)
        if resp.status_code >= 300 and resp.status_code not in (400, 404):
            raise StorageError(f"delete failed ({resp.status_code})")


def _reason(resp: httpx.Response) -> str:
    """Supabase's own explanation (e.g. "Bucket not found"); never includes our credentials."""
    try:
        body = resp.json()
        return str(body.get("message") or body.get("error") or "")[:200]
    except Exception:
        return ""
