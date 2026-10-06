"""Filesystem storage for local development and tests. Not allowed in staging/production."""

from __future__ import annotations

from pathlib import Path

from app.storage.base import StorageError


class LocalStorage:
    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()

    def _path(self, bucket: str, key: str) -> Path:
        path = (self._root / bucket / key).resolve()
        if not path.is_relative_to(self._root / bucket):
            raise StorageError("invalid storage key")
        return path

    def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        path = self._path(bucket, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, bucket: str, key: str) -> bytes | None:
        path = self._path(bucket, key)
        return path.read_bytes() if path.is_file() else None

    def delete(self, bucket: str, key: str) -> None:
        self._path(bucket, key).unlink(missing_ok=True)
