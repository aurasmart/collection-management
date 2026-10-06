# ADR 0003 — Stage 3 amendments A3–A7 (approved with the Stage 3 plan)

| # | Decision |
|---|---|
| A3 | No separate job table. The queue is `import_batches` rows claimed with `SELECT … FOR UPDATE SKIP LOCKED`; columns `attempts`, `locked_at`, `confirmed_mapping`, `extraction_method` exist. |
| A4 | `import_rows` carries `ocr_confidence`, `source_snippet`, `original_values`, `duplicate_action`, `duplicate_of_row_id`, `source_method`, `requires_review` (needed by Stage 2 review UX). |
| A5 | Idempotency without a table: clients generate the UUID primary key for payments / payment_requests; a PK conflict returns the existing row. Import confirm is guarded by a batch-status lock. |
| A6 | Employers are created by an operator script (no signup UI). Script arrives in Phase 1. |
| A7 | The QR snapshot is streamed by the API after the precedence check; storage buckets stay private. |

## Tenancy implementation (Phase 0)
- `employer_id` is on every tenant table (including `import_rows`, `payments`, `notifications`) so RLS needs no joins (Stage 1 B2 / R1).
- The API connects with one DB user and, per request transaction, runs `SET LOCAL ROLE app_rls` (no BYPASSRLS) and sets `app.employer_id` from the **verified JWT** (never from the request).
- The only pre-tenant lookup is the SECURITY DEFINER function `resolve_employer_id(auth_user_id)`.
- `audit_events` is append-only for `app_rls` (no UPDATE/DELETE grant).
