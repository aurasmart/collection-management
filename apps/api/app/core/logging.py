"""JSON logging with defensive redaction (no tokens / JWTs / bearer values in logs)."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime

_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*")
_BEARER = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
_SECRET_KV = re.compile(r"(?i)\b(token|secret|password|api[_-]?key)=([^&\s]+)")


def redact(text: str) -> str:
    text = _JWT.sub("[redacted-jwt]", text)
    text = _BEARER.sub("Bearer [redacted]", text)
    return _SECRET_KV.sub(lambda m: f"{m.group(1)}=[redacted]", text)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
