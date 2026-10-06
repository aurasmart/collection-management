# CLAUDE.md — project conventions and rules

Collection-management MVP for employers (India / INR). Employer uploads a file → reviews extracted
records → confirms import → generates a secure payment request → sends it manually (WhatsApp/SMS/copy)
→ customer pays externally → employer records the payment.

## Source of truth (authoritative — do not contradict)
- `docs/stage-1-system-design.md` — product, data model, security, lifecycle (incl. Revision 1)
- `docs/stage-2-ui-ux.md` — screens, states, design system (incl. "Corrections Applied")
- `docs/stage-3-implementation.md` — stack, repo layout, phases
- `docs/adr/` — approved amendments (token storage, hash routing, queue/staging/idempotency)

If a requirement conflicts with these, **STOP and report it**. Never make an independent product,
architecture, data-model, security, payment-request, token or user-flow decision.

## Status
Phase 0 (Foundations) only. Do **not** start Phase 1+ until the owner approves. Phases: 0 Foundations →
1 Auth & Settings → 2 Import pipeline (Excel/CSV) → 3 Collections & Dashboard → 4 Payment requests & public page →
5 Payments & History → 6 Word/PDF/OCR/AI → 7 Hardening.

## Architecture
- `apps/web` — React 19 + TypeScript (strict) + Vite PWA, Tailwind v4 + Radix primitives, TanStack Query,
  **hash router** (customer URL `/#/pay/<token>`, ADR 0002). Only talks to the backend through the typed OpenAPI client.
- `apps/api` — FastAPI + SQLAlchemy 2 + Alembic (Python 3.12, uv). One image runs the API and the worker
  (`python -m app.worker`). Module layout: `app/core` (config, db, security, tenancy, crypto, logging),
  `app/modules/<name>` (router/service/schemas), later `app/processing`.
- `packages/api-types` — `openapi.json` (committed contract) + generated `schema.d.ts`. Regenerate with `make api-types`.
- Database: PostgreSQL 16 (Supabase). Auth: Supabase Auth (JWT verified by the API). Storage: private buckets (later).
- Hosting: frontend = GitHub Pages; backend + worker = Render (`infra/render.yaml`); local = `infra/docker-compose.yml`.

## Frozen product defaults
India · INR · +91 · email+password login · no payment-request expiry in V1 · import files kept 90 days after
successful import · failed/discarded files 7 days · **no** customer "I've Paid"/UTR · **no** payment gateway ·
**no** automated WhatsApp/SMS provider · AI is fallback-only, feature-flagged, cost-capped (proposals only) ·
partial payment: existing request stays an immutable snapshot; employer explicitly regenerates for the remaining balance.

## Security rules (non-negotiable)
1. `employer_id` is derived **server-side from the verified JWT** (`app/core/tenancy.py`). Never accept it from a
   request body, query string, header or path.
2. Every tenant query runs in `tenant_session()`: `SET LOCAL ROLE app_rls` (no BYPASSRLS) + `app.employer_id`.
   Every tenant table has `employer_id`, RLS enabled and a policy. A test fails if a table lacks RLS.
3. Service-role/DB credentials, `TOKEN_ENC_KEY`, `TOKEN_HMAC_SECRET`, `ANTHROPIC_API_KEY` are **backend-only**.
   Frontend env (`VITE_*`) is public values only. No secrets in git (`.env*` ignored; gitleaks in CI).
4. Payment token model (ADR 0001): CSPRNG token → HMAC **lookup hash** + AES-GCM **encrypted token** (employer-side
   retrieval only) → ciphertext **erased** on revoke/regenerate/cancel. Token/ciphertext never appear in list/detail/
   dashboard responses, logs or audit events. Snapshot columns are immutable (DB trigger).
5. Never trust the browser: validate server-side; OCR rows can never be imported without explicit human acceptance (DB + API).
6. No tokens, JWTs or PII in logs (`app/core/logging.py` redacts defensively; do not rely on it).

## Conventions
- Prefer simple, readable code over premature abstraction. No Redis/Celery/Kafka/microservices/k8s, no Redux/global store.
- Backend: `ruff` (lint+format), `mypy --strict`, `pytest`. Tests live beside the feature in `apps/api/tests`.
  Tests need Postgres: `TEST_DATABASE_URL` (see README). DB changes = new Alembic migration (never edit an applied one).
- Frontend: strict TS, ESLint (a11y plugin, `--max-warnings 0`), Prettier, Vitest + Testing Library.
  Use `@/` imports, UI primitives from `@/components/ui`, route paths from `@/lib/routes`, money via `formatINR`.
- UI must follow Stage 2: every status = icon + text; states for loading/empty/error; 44px touch targets; ₹ with Indian grouping.
- API changes: update code → `make api-types` → commit `packages/api-types/*`. CI fails on drift.
- Commits: small, conventional (`feat:`, `fix:`, `chore:`, `docs:`). Never commit secrets. PRs required for `main`.

## Commands
`make install` · `make db-up` · `make migrate` · `make api` · `make web` · `make test` · `make lint` · `make check`
