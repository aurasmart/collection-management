# Backend image: used for BOTH the API (default CMD) and the worker (override CMD: python -m app.worker).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    OMP_THREAD_LIMIT=1 \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

# Tesseract: reads scanned PDFs (runs inside the request; no background worker).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

RUN useradd --system --no-create-home appuser
USER appuser

EXPOSE 8000
# Render sets $PORT. --proxy-headers because TLS terminates at the platform proxy.
# RUN_MIGRATIONS=true applies pending Alembic migrations before the server starts (single-instance hosts such as
# Render's free plan, which has no pre-deploy step). Leave it unset for the worker and for local runs.
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = true ]; then alembic upgrade head || exit 1; fi; exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
