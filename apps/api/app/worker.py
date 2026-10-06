"""Background worker entrypoint (`python -m app.worker`).

Phase 0: lifecycle only (start, heartbeat, graceful shutdown). The import-processing loop
(`import_batches` claimed with FOR UPDATE SKIP LOCKED, docs/adr/0003) arrives in Phase 2.
"""

from __future__ import annotations

import logging
import signal
import threading
import types

from app.core.logging import configure_logging

log = logging.getLogger("worker")


def run(*, once: bool = False, interval_seconds: float = 30.0) -> None:
    stop = threading.Event()

    def _stop(_signum: int, _frame: types.FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log.info("worker started (no job handlers in Phase 0)")
    while not stop.is_set():
        log.info("worker heartbeat")
        if once or stop.wait(interval_seconds):
            break
    log.info("worker stopped")


if __name__ == "__main__":
    configure_logging()
    run()
