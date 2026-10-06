# Convenience wrappers. Everything here is also documented as plain commands in README.md.
COMPOSE = docker compose -f infra/docker-compose.yml
TEST_DB ?= postgresql://postgres:postgres@localhost:5432/postgres

.PHONY: install db-up db-down migrate api worker web test test-api test-web lint typecheck build api-types check

install:
	npm ci
	cd apps/api && uv sync

db-up:
	$(COMPOSE) up -d --wait db

db-down:
	$(COMPOSE) down

migrate:
	cd apps/api && uv run alembic upgrade head

api:
	cd apps/api && uv run uvicorn app.main:app --reload --port 8000

worker:
	cd apps/api && uv run python -m app.worker

web:
	npm run dev

test-api:
	cd apps/api && TEST_DATABASE_URL=$(TEST_DB) uv run pytest

test-web:
	npm test

test: test-api test-web

lint:
	cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy
	npm run lint && npm run format:check

typecheck:
	npm run typecheck

build:
	npm run build

# Regenerate the OpenAPI contract and TypeScript types (commit both files).
api-types:
	cd apps/api && DATABASE_URL=postgresql://x:x@localhost/x \
	  TOKEN_ENC_KEY=$$(python3 -c "import base64;print(base64.b64encode(bytes(32)).decode())") \
	  TOKEN_HMAC_SECRET=$$(python3 -c "print('x' * 32)") \
	  uv run python -m app.export_openapi ../../packages/api-types/openapi.json
	npm run api-types

check: lint typecheck test build
