# Collections — employer collection-management MVP

Upload a spreadsheet/PDF/Word file of amounts you are owed → review the extracted records → confirm import →
send customers a secure payment-instructions link → record payments.
**Status: Phase 0 (foundation).** The app shell, API, database schema, auth wiring and CI exist; the product
features arrive in later phases (see `docs/stage-3-implementation.md`).

Authoritative design docs: `docs/stage-1-system-design.md`, `docs/stage-2-ui-ux.md`, `docs/adr/`. Rules for contributors/agents: `CLAUDE.md`.

## Prerequisites
- Node.js ≥ 22 and npm
- [uv](https://docs.astral.sh/uv/) (installs Python 3.12 automatically)
- Docker (for local Postgres) — or any PostgreSQL 16 you can connect to

> Intel Macs: `cryptography` is pinned `<49` because newer releases ship no x86_64-macOS wheels.

## Run locally (exact commands)

```bash
# 1. install dependencies
npm ci
(cd apps/api && uv sync)

# 2. start Postgres
docker compose -f infra/docker-compose.yml up -d --wait db

# 3. backend config (git-ignored .env)
cp apps/api/.env.example apps/api/.env
#   fill these three in apps/api/.env:
#   TOKEN_ENC_KEY=$(python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")
#   TOKEN_HMAC_SECRET=$(python3 -c "import secrets;print(secrets.token_hex(32))")
#   SUPABASE_JWT_SECRET=<any long random string for local dev, or your Supabase JWT secret>

# 4. migrate the database
(cd apps/api && uv run alembic upgrade head)

# 5. run the API  -> http://localhost:8000/healthz  (docs at /docs)
(cd apps/api && uv run uvicorn app.main:app --reload --port 8000)

# 6. run the web app (new terminal)  -> http://localhost:5173
cp apps/web/.env.example apps/web/.env.local
npm run dev
```
The Dashboard placeholder shows **System status**: "API reachable (ok)" when the frontend can reach the backend.
Optional worker (heartbeat only in Phase 0): `(cd apps/api && uv run python -m app.worker)`.

Shortcuts: `make install db-up migrate api web worker`.

### Authentication (foundation)
The API verifies Supabase JWTs (`SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET`) and derives the employer from the
token's `sub` via the `employers.auth_user_id` link. There is **no login screen yet** (Phase 1). To exercise it by hand:

```bash
psql postgresql://postgres:postgres@localhost:5432/postgres -c \
 "insert into employers (auth_user_id,name,email) values ('11111111-1111-1111-1111-111111111111','Demo','demo@example.test')"
TOKEN=$(cd apps/api && uv run python -c "import jwt,time;print(jwt.encode({'sub':'11111111-1111-1111-1111-111111111111','aud':'authenticated','exp':int(time.time())+3600},'<SUPABASE_JWT_SECRET>',algorithm='HS256'))")
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/me
```

## Tests and checks
```bash
# backend (needs Postgres; uses a superuser to seed data, then proves RLS through the app role)
(cd apps/api && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres uv run pytest)
(cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy)

# frontend
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```
`make check` runs everything. After changing the API: `make api-types` and commit `packages/api-types/*`.

## Repository layout
```
apps/web          React + TS + Vite PWA (hash router)
apps/api          FastAPI API + worker, Alembic migrations, tests, Dockerfile
packages/api-types   OpenAPI contract + generated TypeScript types
infra             docker-compose (local) and render.yaml (backend + worker)
docs              Stage 1/2/3 documents, ADRs, runbook
.github           CI, GitHub Pages deploy, Dependabot
```

## Deployment
See `docs/runbook.md` (GitHub Pages variables, Render blueprint, Supabase settings, secret scanning).
No secrets are committed: configuration is via environment variables (`apps/api/.env.example`, `apps/web/.env.example`).
