<!-- AUTHORITATIVE. Approved Stage 3 implementation plan. Phase 0 only is authorised so far. -->

# STAGE 3 — IMPLEMENTATION PLAN (planning only — no code written yet)

**Context.** Stages 1 and 2 are approved. This section fixes the exact stack, repository layout, deployment architecture and build phases for Stage 3. Implementation proceeds phase by phase, each authorised separately by the project owner. The repository is a monorepo (see §3.2); the approved Stage 1, Stage 2 and Stage 3 documents are kept under `docs/` and are authoritative.

## 3.0 Amendments to earlier stages surfaced while planning (flagged, minimal)
| # | Item | Why | Proposed handling |
|---|---|---|---|
| A1 | **Token stored encrypted + hash** (approved in Stage 2 review) | "Copy link later" | `payment_requests`: add *encrypted token* column (AES-256-GCM, key id for rotation), keep lookup hash (HMAC-SHA256 with separate secret); erase ciphertext on revoke |
| A2 | **Pay URL form** | GitHub Pages has no SPA fallback; Stage 1 left routing to Stage 3 | Hash routing: `https://app.<domain>/#/pay/<token>`. Bonus: the token is in the URL fragment, so it is never sent to GitHub Pages, logs or `Referer`. Same URL shape for the entire app. *(Alternative: path URLs + 404.html redirect hack — rejected: first load returns HTTP 404, token appears in requests.)* |
| A3 | **No separate job table** | Stage 1 said "DB-backed queue" | Queue = `import_batches` rows polled with `SELECT … FOR UPDATE SKIP LOCKED`; add columns `attempts`, `locked_at`, `confirmed_mapping`, `extraction_method`. No new table |
| A4 | **Staging columns required by Stage 2 UX** | OCR confidence, source snippet, original values, duplicate choice | `import_rows` add: `ocr_confidence`, `source_snippet`, `original_values` (JSON), `duplicate_action`, `duplicate_of_row_id`; (some already in Stage 1 Revision 1) |
| A5 | **Idempotency without a new table** | Double-submit safety (confirm import, record payment, create request) | Client generates the UUID primary key for payments/payment_requests; PK conflict returns the existing row. Import confirm guarded by batch-status lock |
| A6 | **Employer provisioning** | Stage 2 has no registration | Employer + auth user created by an operator CLI/script (`create-employer`); no signup UI. **Decision D1** |
| A7 | **QR delivery on public page** | Public bucket would bypass revocation | API streams the snapshot QR after the precedence check; storage buckets stay private |

## 3.1 Final technology stack (exact)
| Layer | Choice | Notes |
|---|---|---|
| **Frontend** | **React 19 + TypeScript (strict) + Vite**, hash router (**React Router**), **TanStack Query** (server state), **react-hook-form + zod** (forms/validation), **Tailwind CSS** + **Radix UI primitives** (accessible dialogs/menus/tabs/toasts) wrapped in our own `ui/` components, **lucide-react** icons, **TanStack Virtual** (review table), **vite-plugin-pwa** (manifest + minimal service worker; no offline data caching), **openapi-typescript** (types generated from the API schema) | No state library beyond Query + React state. Inter + ui-monospace fonts self-hosted |
| **Frontend tests** | Vitest, Testing Library, **Playwright** (E2E, mobile + desktop viewports), **axe-core** (a11y checks) | |
| **Backend API** | **Python 3.12 + FastAPI**, Pydantic v2, **SQLAlchemy 2.0 + Alembic**, psycopg 3, Uvicorn/Gunicorn, **uv** for dependency management, **ruff** + **mypy** | REST/JSON, OpenAPI is the contract |
| **Worker** | Same codebase/image, entrypoint `python -m app.worker` | Polls `import_batches` (A3) |
| **Parsing** | `openpyxl` (.xlsx), `xlrd` (.xls), stdlib `csv` + `charset-normalizer`, `python-docx` (.docx), `pdfplumber` + `pypdfium2` (text PDF / page rendering), **Tesseract OCR** (`pytesseract`, installed in the Docker image), `rapidfuzz` (header matching), `phonenumbers`, `python-dateutil`, `decimal` for money, `filetype`/magic-bytes for detection | Deterministic first; zip-bomb/size/time guards |
| **AI fallback** | **Anthropic API** behind an `AiAdapter` interface, feature-flagged, cost-capped. Default model **`claude-haiku-4-5-20251001`** for column mapping/segmentation (configurable via env; Sonnet 5.5 selectable for hard PDFs). Sends headers + few sample rows or minimal text only | Output is only ever a *proposal*; OCR/AI rows forced to review |
| **Database** | **PostgreSQL 16 on Supabase**, accessed by the API through a **non-superuser role with RLS enabled** (`SET LOCAL app.employer_id` per transaction) — defence-in-depth behind the API-level `employer_id` filter | Plain SQL/Alembic migrations; no Supabase-specific features required, so portable |
| **Auth** | **Supabase Auth** (email + password, reset-by-email). Frontend uses `supabase-js` **only** for login/refresh/reset; **all data goes through our API**, which verifies the JWT. Re-auth for settings = backend verifies the password via Supabase | Behind an `AuthProvider` interface to avoid lock-in |
| **File storage** | **Supabase Storage**, private buckets `imports`, `qr`; `StorageService` interface (S3-compatible swap-in); short-lived signed URLs only for employer access | Retention job: delete originals after 90 days (Stage 1 default) |
| **Crypto** | `cryptography` (AES-256-GCM for token ciphertext), `secrets.token_urlsafe(32)` for tokens, HMAC-SHA256 for lookup hash; keys from env/secret store, versioned | |
| **Notifications** | `NotificationService` + `ManualProvider` only (wa.me / sms: deep links); WhatsApp/SMS provider interfaces stubbed, not wired | |
| **Rate limiting** | `slowapi` (in-process; single API instance for MVP) on login-adjacent, public pay and "get link" endpoints | Move to DB/Redis if scaled out |
| **Observability** | JSON structured logs (no PII/tokens), `/healthz` + `/readyz`, optional **Sentry** (free tier, PII scrubbing on) | |
| **Backend tests** | pytest, httpx, Postgres via testcontainers, golden-file fixtures for parsers | |
| **CI/CD** | **GitHub Actions** | See 3.3 |
| **Hosting** | Frontend: **GitHub Pages** (custom domain). API + worker: **Render** (Docker; one web service + one background worker). DB/Auth/Storage: **Supabase** | Alternatives (Fly.io/Railway) are drop-in because the app is a plain container |

**Cost reality check (honest):** pilot ≈ **$0–15/mo** (Supabase free + Render web free tier is *not* enough for a worker; worker/starter ≈ $7–14). **Production with real money data should use Supabase Pro (~$25/mo)** because the free tier pauses on inactivity and lacks backups. Plus a domain (~$10–15/yr) and an SMTP sender for reset emails (free tier of Resend/Brevo). GitHub Pages on a **private** repo needs a paid GitHub plan; on a public repo it's free but all code is public (no secrets are ever committed either way).

## 3.2 Repository structure (monorepo)
```
employee-management/                 # name TBD (Decision D4)
├─ .github/
│  ├─ workflows/ (web-ci, api-ci, deploy-web, deploy-api, codeql/secret-scan)
│  ├─ dependabot.yml
│  └─ pull_request_template.md
├─ docs/
│  ├─ stage-1-system-design.md  stage-2-ui-ux.md  stage-3-implementation.md
│  ├─ adr/                         # short decision records (token storage, hash routing…)
│  └─ runbook.md                   # deploy, rotate keys, restore, provision employer
├─ apps/
│  ├─ web/                         # Vite + React PWA
│  │  └─ src/
│  │     ├─ app/                   # router, providers, shell, session-expiry modal
│  │     ├─ components/ui/         # Button, Input, Badge, Alert, Modal, Sheet, Toast, Table…
│  │     ├─ features/
│  │     │   auth/ dashboard/ imports/ (upload, processing, mapping, review, ocr, duplicates, confirm)
│  │     │   collections/ payment-requests/ payments/ settings/ pay/ (public)
│  │     ├─ lib/ (api client, money, date, phone, format, a11y helpers)
│  │     └─ styles/ (tokens, tailwind config)
│  └─ api/                         # FastAPI service + worker (one Python package)
│     ├─ app/
│     │  ├─ core/        config, security (jwt, crypto), db, tenancy (employer ctx + RLS), errors, logging
│     │  ├─ modules/     auth · dashboard · imports · collections · payments ·
│     │  │               payment_requests · public_pay · notifications · settings · audit
│     │  │               (each: router, service, repository, schemas)
│     │  ├─ processing/  detect · extractors/(xlsx,xls,csv,docx,pdf_text,pdf_ocr) · mapping ·
│     │  │               normalize · validate · duplicates · ai_adapter · pipeline
│     │  ├─ storage/     StorageService + Supabase impl
│     │  ├─ notifications/providers/  manual.py (+ interfaces)
│     │  ├─ worker.py
│     │  └─ main.py
│     ├─ migrations/     # Alembic (schema + RLS policies)
│     ├─ tests/          # unit, integration, parser fixtures
│     ├─ scripts/        # create-employer, rotate-token-key, purge-retention
│     └─ Dockerfile
├─ packages/
│  └─ api-types/         # generated TS types from OpenAPI (CI-checked for drift)
├─ infra/
│  ├─ render.yaml        # web + worker services
│  └─ docker-compose.yml # local: Postgres (+ Supabase CLI for auth/storage)
├─ .env.example files (no secrets), .gitignore, README.md
└─ CLAUDE.md             # conventions for future sessions
```
Conventions: trunk-based, short-lived branches, PR required for `main`, conventional commits, squash merge. Frontend never imports backend code; contract = OpenAPI.

## 3.3 Deployment architecture
```
 Browser / PWA ──HTTPS──► app.<domain>   GitHub Pages (static; custom domain, Enforce HTTPS/HSTS)
      │  Authorization: Bearer <Supabase JWT>  (login/refresh/reset → Supabase Auth directly)
      ▼
 api.<domain>  ──► Render Web Service (FastAPI, Docker)     ◄── CORS: only https://app.<domain>
      │                    │
      │                    ├──► Supabase Postgres (RLS role)   [import_batches = queue]
      │                    ├──► Supabase Storage (private: imports, qr)
      │                    └──► Anthropic API (flagged; minimal data)
      ▼
 Render Background Worker (same image) ── polls batches → parse/OCR → staging rows
 Public customer: https://app.<domain>/#/pay/<token> ──► GET api.<domain>/public/pay (token in header/body, rate-limited, no-store)
```
- **Environments:** local (docker compose + Supabase CLI), **staging** (own Supabase project + Render services + `staging.` Pages path/branch), **production**. Separate keys per env.
- **Secrets:** only in Render env vars / GitHub Actions secrets / Supabase. Frontend build gets *public* values only (`VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Service-role key, token-encryption key, HMAC secret, Anthropic key are **backend-only**. Secret scanning + push protection on.
- **CI:** web (typecheck, lint, unit, build, Playwright smoke) → deploy to Pages on `main`. API (ruff, mypy, pytest with Postgres) → build image → Render deploy hook; **Alembic migrations run as a pre-deploy step**; OpenAPI type-drift check.
- **Headers limitation:** GitHub Pages can't set custom response headers; use `<meta>` CSP/referrer policy and `noindex` on the pay route; API sets security headers (and `Cache-Control: no-store` on payment endpoints). If stricter headers are later needed, put Cloudflare in front of Pages (no code change).
- **Backups/ops:** Supabase PITR/daily backups (Pro), documented restore in runbook; retention job (originals 90 days, failed/discarded 7 days) as a scheduled Render cron or worker loop.

## 3.4 Implementation phases
Each phase ends with a demoable slice, passing tests, and a PR-sized review checkpoint. Sizes are relative (S ≈ days, M ≈ 1–2 weeks, L ≈ 2–3 weeks for one developer working with Claude).

| Phase | Scope | Key deliverables | Exit criteria | Size |
|---|---|---|---|---|
| **0 — Foundations** | Repo init, docs saved, CI skeleton, environments, Supabase/Render projects, local dev, design tokens, UI kit baseline | Monorepo, `docker-compose`, Alembic baseline (**all tables + RLS + A1/A3/A4 columns**), OpenAPI→types pipeline, `ui/` primitives (Button, Input, Badge, Alert, Modal/Sheet, Toast, Skeleton), app shell + nav (sidebar/tab bar) | `main` deploys empty shell to Pages + health-checked API; RLS tenant-isolation test passes | M |
| **1 — Auth & Settings** | S1, S12, S10 | Login/logout/reset, JWT verification, tenancy context, session-expiry modal, payment settings with validation, QR upload, re-auth modal, preview, settings change audit, `create-employer` script | Login E2E; cross-tenant access denied in tests; settings saved only after re-auth | M |
| **2 — Import pipeline (Excel/CSV)** | S3–S7 for tabular files | Upload validation + hash duplicate-file warning, detection, xlsx/xls/csv extractors, header detection, synonym mapping + confidence, normalization, hard/warn/info validation, row & in-file duplicate detection, staging, worker loop, Processing screen, Mapping screen, Review (table/cards, drawer, filters, search, virtualized), duplicate compare (Skip/Import Anyway/Review Existing), Confirm (single transaction, idempotent), Recent imports | 2,000-row file processed <60s; failed job leaves collections untouched; every Stage 2 review state implemented; golden-file parser tests | L |
| **3 — Collections & Dashboard** | S2, S8, S9 core | Collections list (filters/sort/pagination/URL state), derived status logic (OVERDUE, PARTIALLY_PAID, outstanding) in one backend service, detail page, edit rules, cancel/reopen, dashboard metrics + states | Totals reconcile with list; large-list performance budget met | M |
| **4 — Payment requests & public page** | S9b–S9d, S9c, S11, §15–17 | Snapshot creation (incl. QR copy), token generation/encryption/hash, one-ACTIVE constraint, regenerate/revoke, "get link" endpoint (A1), Out-of-date & Balance-changed notices, outdated-requests count on Settings, manual WhatsApp/SMS/Copy with message preview + "Did you send it?" → SENT, public pay page with precedence rule + QR streaming + rate limiting | Precedence table fully covered by tests; revoked link never reactivates; no token in any list/log response | L |
| **5 — Payments & History** | S9e, S9f, §20–23 | Record Payment (single-step VERIFIED, validations, live result), Void with reason, status recomputation in-transaction, partial-payment flow, History tab from `audit_events` (all write paths audited) | ₹10,000 → ₹4,000 → ₹6,000 → regenerate journey passes E2E | M |
| **6 — Word, PDF, OCR, AI fallback** | §8, §10, rest of S5/S6 | docx tables/text extractor, text-PDF table extraction, scanned-PDF OCR path, AI mapping/segmentation adapter (flagged, cost-capped), OCR badge/confidence/source snippet, per-row accept, blocker panel, server-side OCR rule (cannot import unreviewed OCR rows) | OCR rows can't be imported without human accept (API test + E2E); no bulk accept anywhere | L |
| **7 — Hardening & launch** | NFRs | Security pass (authz matrix tests, upload abuse tests, rate limits, CSP), accessibility audit (axe + manual keyboard/screen-reader), PWA install check, performance pass, error/offline states, retention job, runbook, production cut-over | All Stage 1 §26 NFRs verified; no open P0/P1 | M |
*(Stage 4 — Testing & Deployment — formalises UAT and production sign-off; automated tests are written inside every phase, not deferred.)*

## 3.5 Cross-cutting engineering rules
1. **Single source of truth for money/status logic:** one backend service computes outstanding, derived badges and request notices; frontend only renders.
2. **Tenant isolation everywhere:** repository layer requires an employer context; RLS as second line; a test suite attempts cross-tenant reads/writes on every resource.
3. **Never trust the browser:** validation duplicated server-side (zod mirrors Pydantic); OCR/duplicate/error rules enforced server-side.
4. **Idempotent mutations** (A5) and transactional audit writes.
5. **Snapshots immutable:** no update path in code; DB trigger/constraint blocks UPDATE of snapshot columns.
6. **No PII or tokens in logs, errors, analytics or audit details.**
7. **Definition of done:** typed, tested, a11y-checked against Stage 2 spec states (loading/empty/error), PR reviewed, deployed to staging.

## 3.6 Risks specific to implementation
Parser accuracy on real customer files (mitigate: collect 5–10 sample files early; golden tests) · OCR quality/cost · Render/Supabase free-tier limits · Password-reset email deliverability · Pages hash-routing in in-app browsers (verify WhatsApp/SMS in-app browser behaviour early, Phase 4) · token-key management/rotation · Anthropic data-handling approval (Stage 1 W1).

## 3.7 Decisions needed from you before Phase 0
| # | Decision | My recommendation |
|---|---|---|
| D1 | **How are employer accounts created?** (no signup UI) | Operator script now; revisit self-signup later |
| D2 | **Supabase (Postgres+Auth+Storage) vs. self-managed pieces** | Supabase, behind interfaces, for speed/cost |
| D3 | **Backend host** | Render (web + worker, Docker). Confirm you accept ~$7–14/mo for the worker, or choose "run worker inside API process" (cheaper, less isolation) |
| D4 | **Repo/domain:** GitHub org/user + repo name, **public vs private**, and the domain you own for `app.` and `api.` | Private repo + paid Pages plan, or public repo (no secrets either way); need a domain for trustworthy pay links |
| D5 | **Pay URL form** (A2 hash routing) | Approve hash routing |
| D6 | **Password-reset email sender** | Resend or Brevo free tier |
| D7 | **AI/OCR:** approve Anthropic API usage (Stage 1 W1 default: yes, minimal data) and provide a key later | Approve, feature-flagged |
| D8 | **Sample files:** can you provide 3–5 real (anonymised) collection files (Excel/CSV/Word/PDF/scanned)? | Strongly recommended before Phase 2 |
| D9 | Approve amendments **A1–A7** above | Approve |

## 3.8 Verification (end-to-end, per phase and at release)
- Per phase: unit + integration tests green in CI; Playwright journeys from Stage 2 (A–H) added as each becomes possible (A: Phase 2; B/C: Phase 4; D/E: Phase 5; F: Phase 4; G: Phase 6; H: Phase 2).
- Release: run all journeys on desktop + 360px mobile viewports; axe scan clean; tenant-isolation suite; public-page precedence suite; token-leak test (token absent from list responses, logs, audit); upload abuse suite (wrong magic bytes, zip bomb, oversized, macro files); restore-from-backup drill.

