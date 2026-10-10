# Collections — employer collection-management MVP

Upload a spreadsheet/PDF/Word file of amounts you are owed → review the extracted records → confirm import →
send customers a secure payment-instructions link → record payments.
**Status: the simple payment flow is built on top of the Phase 0 + 1 foundation** (see `docs/adr/0006-simple-payment-flow-mvp.md`):

1. Sign up (or sign in) → **Upload** an Excel (.xlsx/.xls), CSV, PDF (scanned PDFs are read with OCR) or Google Sheet. Columns are
   detected automatically and you confirm the mapping (Customer Name, Amount Due, Phone, Reference, Due Date optional).
   A sample is at `/sample-customers.csv`.
2. Check and fix the rows, then **Import** → customers appear in **Collections** as *Pending*.
3. Open a customer → **Generate Payment Page** → **Copy Link**, **Send on WhatsApp** or **Send SMS** (plain deep links).
4. The customer opens the link (no login) and sees the amount plus your UPI ID, your **general company QR** (set in Settings,
   never generated per customer) and bank details. They pay outside the app.
5. You click **Mark as Paid** (or **Mark as Unpaid** to correct it). The Collections page can be sorted (date, amount, name),
   filtered (overdue, due date, amount, added date, payment page, phone) and customers can be **deleted** one by one or in bulk. The **Dashboard** shows outstanding, pending customers, paid and totals.

No payment gateway, no UPI API, no automatic payment checking. Set your UPI ID / QR / bank details first under **Settings**.

New here? Start with `docs/development-guide.md` (architecture, code map, deployment lessons).
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

### Authentication, provisioning and settings (Phase 1)
Sign in, **sign up** and password reset use **Supabase Auth** from the browser (public anon key only); every data
call goes to our API with the user's access token. A new person signs up on `/#/signup`; after they confirm their email
and sign in, the API creates their workspace (employer, company profile, payment settings) from the verified session
(ADR 0007). Enable "email signups" and set the password minimum to 12 in the Supabase project.

An operator can also create an employer directly. This needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
`apps/api/.env` (backend/operator machine only; never in the browser):

```bash
cd apps/api
uv run python -m app.provisioning create --full-name "Asha Rao" --company "Acme Traders" \
    --email owner@acme.example [--phone "98765 43210"]                       # prompts for the password
uv run python -m app.provisioning create --full-name "Asha Rao" --company "Acme Traders" \
    --email owner@acme.example --auth-user-id <existing Supabase auth user id>   # link instead of create
```
It refuses duplicates, requires a 12+ character password, never prints the password, and removes a freshly created
Supabase user if the database step fails. For local development without Supabase, link an existing/test auth user with
`--auth-user-id` and sign API calls with a locally minted JWT (see `apps/api/tests/conftest.py::make_jwt`).

Configure the web app with `apps/web/.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`,
`VITE_PUBLIC_APP_URL`). Without them the app shows "Sign-in isn't configured" instead of redirecting in a loop.

QR images and logos live in a **private** bucket (`QR_BUCKET`, default `qr`); receipts in a second private bucket (`RECEIPTS_BUCKET`, default `receipts`), via `STORAGE_BACKEND=supabase`; the default
`local` backend writes to `.local-storage/` for development only and is rejected in staging/production.

Verification notes: ADR 0004 (re-authentication) and ADR 0005 (password reset: PKCE vs hash router) in `docs/adr/`.

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
infra             docker-compose (local), render.yaml (API on Render), smoke-test.sh
docs              Stage 1/2/3 documents, ADRs, runbook, development guide
.github           CI, GitHub Pages deploy, Dependabot
```

## Deployment
Frontend on **GitHub Pages**, API on **Render** (Docker), database/auth/storage on **Supabase**. See `docs/runbook.md`
(step-by-step setup, variables, rollback) and run `infra/smoke-test.sh <api-url> <site-origin>` to verify a deployment.
No secrets are committed: configuration is via environment variables (`apps/api/.env.example`, `apps/web/.env.example`).
