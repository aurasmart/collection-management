# Development guide — how the whole app fits together

A working overview for anyone (or any agent) picking this project up. It summarises what exists, how it is built and
deployed, and where to look. The authoritative design is still `docs/stage-1-system-design.md`,
`docs/stage-2-ui-ux.md` and `docs/adr/`; if this guide disagrees with them, they win.

## 1. What the product does

An employer (India, INR) manages money owed to them:

1. **Sign up** (email + password, confirmed by email) or be provisioned by an operator.
2. **Onboarding / Settings**: company profile, payment details (UPI ID, company QR, bank), account, security.
3. **Import** a file of customers and amounts: Excel (.xlsx/.xls), CSV, PDF (text or scanned, via OCR) or a Google Sheet.
4. **Review** the detected columns and rows, fix problems, then **confirm** (all-or-nothing).
5. **Collections**: each customer is a collection (*Pending → Paid*). Generate a **payment page** link and send it by hand
   (copy, WhatsApp or SMS deep link).
6. The customer opens `/#/pay/<token>` with no login and sees the amount and how to pay. They pay outside the app.
7. The employer clicks **Mark as Paid**. The **Dashboard** shows outstanding, pending, paid and totals.

Deliberately **not** built: payment gateway, UPI APIs, automatic payment checking, automated WhatsApp/SMS, partial
payments, per-customer QR codes, AI extraction (ADR 0006).

## 2. Architecture at a glance

```
Browser (React PWA, hash router)
   │  Supabase Auth directly (sign in / sign up / reset, anon key only)
   │  everything else → our API with the user's access token
   ▼
FastAPI (Render) ──► Supabase Postgres (RLS)     Supabase Storage (private bucket "qr")
```

| Part | Tech | Hosted on |
|---|---|---|
| `apps/web` | React 19, TypeScript strict, Vite PWA, Tailwind v4, Radix, TanStack Query, hash router | GitHub Pages |
| `apps/api` | FastAPI, SQLAlchemy 2 (raw SQL), Alembic, Python 3.12, uv, Tesseract in the image | Render (Docker) |
| Database / Auth / Storage | Postgres 16, Supabase Auth (JWT, JWKS), private bucket | Supabase |
| `packages/api-types` | committed `openapi.json` + generated `schema.d.ts` | (build-time only) |

Why a **hash router**: GitHub Pages cannot rewrite unknown paths, and the pay token in the `#` fragment is never sent
to the server (ADR 0002).

## 3. Backend map (`apps/api/app`)

| Path | Responsibility |
|---|---|
| `main.py` | app factory, CORS, security headers, docs disabled in production |
| `core/config.py` | all settings from the environment (`Settings`); missing required values stop startup |
| `core/security.py` | verifies the Supabase JWT (JWKS, issuer, pinned algorithms); exposes `AuthenticatedUser` |
| `core/tenancy.py`, `core/db.py` | derives `employer_id` from the verified user; `tenant_session()` = `SET LOCAL ROLE app_rls` + `app.employer_id` |
| `core/reauth.py` | recent-password check (JWT `amr`, 300 s) for sensitive changes (ADR 0004) |
| `core/crypto.py`, `ratelimit.py`, `logging.py` | token crypto helpers, rate limits, redacting logs |
| `workspace.py` | `create_workspace`: employer + company profile + payment settings + audit event in one transaction |
| `provisioning.py` | operator CLI `python -m app.provisioning create …` (shares `workspace.py`) |
| `modules/me` | `GET /me`, `POST /account/setup` (first sign-in provisioning, idempotent) |
| `modules/company`, `modules/settings` | company profile, payment details, QR upload |
| `modules/imports` | the import pipeline (below) |
| `modules/collections` | list, detail, generate payment page, mark paid/unpaid, `rules.py` |
| `modules/dashboard` | totals |
| `modules/public_pay` | the public, token-based payment page endpoint (rate limited, generic 404) |
| `modules/health` | `/healthz` (process) and `/readyz` (database) |
| `storage/` | `local` (dev only) and `supabase` storage backends |
| `worker.py` | heartbeat worker; the import runs inline in the API for now |

### Import pipeline (`modules/imports`)
`readers` (xlsx, xls, csv, pdf, ocr, Google Sheets) → `structure.find_tables` (finds the data block first, then the
heading band above it; handles merged and repeated headings; skips totals) → `detect` (alias list, fuzzy match, content
signals, Debit/Credit side handling, ledger detection) → mapping screen (user can override) → review rows → server
validation → all-or-nothing confirm. Nothing is hard-coded to one file; real Tally exports (`Creditors.xlsx`) are in the
tests. OCR sits behind an `OcrProvider` abstraction (Tesseract today). Google Sheets works for public sheets or via a
service account, with SSRF guards.

### Database
Migrations in `apps/api/migrations/versions`: `0001_foundation`, `0002_simple_payment_pages`, `0003_company_profiles`.
Never edit an applied migration; add a new one. Every tenant table has `employer_id`, RLS and a policy, and a test
fails if one is missing.

## 4. Frontend map (`apps/web/src`)

`features/` holds one folder per area: `auth` (login, signup, reset, route guard), `onboarding`, `settings` (hub: Company
Profile, Payment Details, Account, Security), `imports` (upload, mapping, review, confirm), `collections`, `dashboard`,
`pay` (public page). Shared code: `components/ui` (primitives), `lib/routes` (route paths), `lib/env.ts` (public config),
`formatINR` for money. The API is called only through the typed client generated from the OpenAPI contract.

## 5. Security rules to keep in mind

- `employer_id` always comes from the **verified JWT**, never from a request.
- Tenant queries run in `tenant_session()`; RLS is the second line of defence.
- The service-role key, `TOKEN_ENC_KEY`, `TOKEN_HMAC_SECRET` and DB credentials are **backend only**. `VITE_*` values
  are public by design.
- The payment token (ADR 0006) is 128-bit random, never in lists, logs or audit events. The QR on the pay page is
  always the one company QR.
- Sensitive settings changes need a recent password sign-in.
- No tokens, JWTs or PII in logs. No secrets in git (`.env*` ignored, gitleaks in CI).

## 6. Running and testing locally

Exact commands are in `README.md`. In short: `make install db-up migrate api web`, then `make check` before a commit.
Backend tests need Postgres (`TEST_DATABASE_URL`). After any API change run `make api-types` and commit
`packages/api-types/*`; CI fails on drift.

## 7. Deployment (as run today)

| What | Where | Notes |
|---|---|---|
| Site | GitHub Pages, `https://aurasmart.github.io/collection-management/` | built by `.github/workflows/deploy-web.yml` from **repository Variables** |
| API | Render web service from `apps/api/Dockerfile` (`infra/render.yaml`) | `/healthz`, `/readyz`; migrations run in the Docker command |
| Data / Auth / Storage | Supabase | **Session pooler** URL (port 5432) for `DATABASE_URL`; private bucket `qr` |

Setup steps, the environment-variable table and rollback are in `docs/runbook.md`. `infra/smoke-test.sh <api-url>
<site-origin>` runs 9 public checks.

Lessons from the first deployment:

- `VITE_*` values are baked in **at build time**. Add them as separate Repository **Variables** (not Secrets, not
  Environment variables, one name and one value each, no spaces), then re-run the *Deploy web* workflow.
- Render stops at startup if a required setting is missing (the log names it, for example `token_hmac_secret`).
- `CORS_ORIGINS` is the site's origin only (`https://aurasmart.github.io`, no path or trailing slash).
- Supabase's built-in email is rate limited; use Resend or Brevo SMTP before real users sign up.
- Render's free plan sleeps after ~15 minutes idle (cold start about a minute); Starter ($7/month) avoids it and adds
  a pre-deploy command.

## 8. Conventions

Small conventional commits (`feat:`, `fix:`, `chore:`, `docs:`), PRs for `main`, no secrets in commits. Backend: ruff,
`mypy --strict`, pytest. Frontend: strict TS, ESLint with the a11y plugin, Prettier, Vitest. UI follows Stage 2 (every
status has icon and text, loading/empty/error states, 44px targets, ₹ with Indian grouping). Product, architecture,
security or data-model decisions are never made on the fly: stop and write an ADR (`docs/adr/`).

## 9. Good next steps

- Move import processing to the worker (the queue design is in ADR 0003) if files get large.
- Add an SMTP provider and a custom domain (then update `CORS_ORIGINS`, Supabase URLs and the `VITE_*` variables).
- Add error monitoring (Sentry) and uptime checks on `/healthz`.
- Upgrade Render to Starter and Supabase to Pro for backups before relying on it for real money records.
