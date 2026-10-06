"""Private object storage interface (Stage 3 §3.1). Implementations never expose public URLs."""

from __future__ import annotations

from functools import lru_cache
from typing import Protocol

from app.core.config import get_settings


class StorageError(Exception):
    """Storage backend failure (never includes credentials)."""


class StorageService(Protocol):
    def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None: ...

    def get(self, bucket: str, key: str) -> bytes | None: ...

    def delete(self, bucket: str, key: str) -> None: ...


@lru_cache
def get_storage() -> StorageService:
    s = get_settings()
    if s.storage_backend == "supabase":
        from app.storage.supabase import SupabaseStorage

        if not (s.supabase_url and s.supabase_service_role_key):  # also enforced by Settings
            raise StorageError("Supabase storage is not configured")
        return SupabaseStorage(s.supabase_url, s.supabase_service_role_key)
    from app.storage.local import LocalStorage

    return LocalStorage(s.local_storage_dir)
