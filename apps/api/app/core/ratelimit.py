"""A tiny in-process rate limiter for the public payment page (no Redis, no extra infrastructure).

Sliding window per client IP, kept in this process's memory. That is fine for one API instance
(our MVP deployment); with several instances each keeps its own counts. Behind Render's proxy
uvicorn runs with --proxy-headers, so `request.client.host` is the real caller.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import HTTPException, Request, status


class RateLimiter:
    def __init__(
        self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.limit, self.window, self._clock = limit, window_seconds, clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> float | None:
        """Record a hit. Returns None if allowed, otherwise seconds until a retry could succeed."""
        now = self._clock()
        hits = self._hits[key]
        while hits and now - hits[0] >= self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return self.window - (now - hits[0])
        hits.append(now)
        if len(self._hits) > 10_000:  # keep memory bounded
            for k in [k for k, h in self._hits.items() if not h or now - h[-1] >= self.window]:
                del self._hits[k]
        return None

    def reset(self) -> None:
        self._hits.clear()


# 60 loads a minute per IP is plenty for a real customer; 15 misses a minute stops token guessing.
public_page_limiter = RateLimiter(limit=60, window_seconds=60)
public_miss_limiter = RateLimiter(limit=15, window_seconds=60)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def too_many(retry_after: float) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many requests. Please wait a minute and try again.",
        headers={"Retry-After": str(int(retry_after) + 1)},
    )
