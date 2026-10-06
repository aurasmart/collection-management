<!--
AUTHORITATIVE PRODUCT DOCUMENT — Stage 1 system design.
Structure of this file (the evolution is intentional; nothing earlier is rewritten):
  1. PART 1 — Approved Stage 1 (original sections A–W + Final Deliverable) and
     PART 2 — Revision 1 (approved amendment). Both are the approved text, VERBATIM
     (recovered from the approved plan in the session transcript; no wording changed).
  2. PART 3 — Subsequent approved amendments, appended in chronological order:
       3.1 Stage 2 review corrections affecting Stage 1 (token storage, public-page precedence,
           "Out of date" vs "Balance changed")
       3.2 Frozen product defaults (Phase 0 authorisation)
       3.3 Stage 3 implementation amendments (pointers to docs/adr)
       3.4 Supersession index
Precedence when text conflicts: PART 3 > PART 2 (Revision 1) > PART 1. Implementation detail lives in docs/adr/.
Do not change without explicit owner approval.
-->

# PART 1 — APPROVED STAGE 1 (original)
# STAGE 1 — System Design & Requirements (Collection Management MVP)

Scope: design only. No code, UI, or deployment files. Stops after this for review; Stage 2 starts only on "Stage 1 approved".

---

## A. Executive Summary
Employers already hold "who owes me how much" in spreadsheets/PDFs/Word files. The product lets them upload that file, have the system extract and normalize it into collection records, **review and confirm** those records, then send each customer a secure link (via WhatsApp/SMS) showing the amount due and how to pay (UPI/QR/bank). The customer pays outside the system; the employer verifies receipt and records the payment, and outstanding balances update. No payment gateway, no customer accounts. The one non-negotiable rule: **extracted data never reaches a customer until a human has confirmed it.**

## B. Assumptions
1. Single currency (INR), India-focused (UPI, +91 phone default, IFSC).
2. One employer = one login = one workspace in MVP, but every row carries `employer_id` (multi-tenant-ready).
3. Files are modest: ≤10 MB, ≤ ~2,000 rows per file.
4. Customer is identified within an employer by normalized phone (fallback: normalized name).
5. Dates parsed day-first (DD/MM/YYYY) unless the file is unambiguous; ambiguous dates become warnings.
6. Payment link is valid until the collection is paid/cancelled or the link is revoked (no automatic time expiry in MVP, optional expiry field reserved).
7. Customer "I've paid" button is not in MVP (see Open Questions).
8. Overdue is computed (due_date < today and outstanding > 0), not manually set.

## C. Actors
- **Employer/Admin** — only authenticated user; everything in the employer area. No roles.
- **Customer** — unauthenticated; sees only one payment page via an unguessable token; read-only.
- (System actors: processing worker, notification service — not users.)

## D. End-to-End User Flow
Login → Dashboard → Upload file → type detection → extract → interpret/normalize → validate → Review screen ("127 detected / 119 ready / 8 need review") → edit/accept/reject → Confirm import → Collections list → select collection → Generate payment request (token link) → Send via WhatsApp/SMS (or copy link) → Customer opens link, sees amount + payment options → pays externally → Employer verifies in bank/UPI app → Records payment → Outstanding recalculated → status PAID when outstanding = 0.

## E. Functional Requirements (by module)
1. **Authentication** — email+password login (or magic link), logout, password reset, session expiry.
2. **Dashboard** — Total outstanding, total collected, pending (unpaid, not yet due), overdue, recent collections (last 10). Computed from collections/payments; no charts.
3. **File Upload** — accept .xlsx .xls .csv .pdf .docx; size/type/content-sniff checks; clear rejection message; upload creates an `import_batch`.
4. **Processing/Interpretation** — async job; parsers → field mapping → normalization → validation; produces *staged* rows, never touching live collections.
5. **Review & Confirmation** — summary counts; filter by errors/warnings; inline edit; accept/reject per row; bulk "accept all ready"; confirm import (only accepted rows with zero hard errors); nothing is sent automatically.
6. **Collections** — list/search/filter by status; detail view (customer, amounts, payments, history); edit rules (§J); cancel.
7. **Payment Request / Customer Page** — generate/revoke link per collection; public page `/pay/<token>`: customer name, amount outstanding, reference, enabled payment methods; "Opening or tapping UPI ≠ paid" disclaimer.
8. **Notifications** — send via WhatsApp or SMS through provider abstraction; manual fallback (copy link / open `wa.me` / `sms:` deep link); log every send attempt.
9. **Payment Settings** — UPI ID, UPI number, QR image, bank details; each method individually enabled; employer display name.

## F. Non-Functional Requirements
- **Performance:** dashboard < 2s on mobile 4G (aggregate queries with indexes; ≤ ~10k collections). Upload processing of 2,000 rows < 60s for deterministic path; shows progress state.
- **Reliability:** processing writes only to staging tables; a failed job leaves live data untouched; import confirm is a single DB transaction; processing is idempotent/retryable.
- **Security:** see §N. Tenant isolation enforced server-side on every query.
- **Scalability:** `employer_id` everywhere; stateless API; worker separable from API; storage behind an interface.
- **Maintainability:** four separated responsibilities — frontend, API/domain, processing, notifications — each behind clear interfaces.
- **Mobile usability:** all employer flows usable at 360px width; review table collapses to cards.
- **Accessibility:** WCAG AA contrast, labeled inputs, error text not color-only, ≥16px body text, ≥44px tap targets.

## G. System Architecture
```
 EMPLOYER (any device)                CUSTOMER (any device)
        |                                      |
        v                                      v
 Responsive Web App / PWA  (static, GitHub Pages)     Public pay page (/pay/<token>)
        |  HTTPS + JWT/session                  |  HTTPS, token only
        +------------------+--------------------+
                           v
                      Backend API  (authz, domain rules, audit)
          +--------+--------+----------+-------------+
          v        v        v          v             v
       Database  File     Auth     Job queue    Notification Service
      (Postgres) Storage (managed)     |            |        |
                 (private)             v         WhatsApp    SMS
                              Processing Worker  Provider   Provider
                    detect → extract (parsers → OCR/AI fallback)
                           → map fields → normalize → validate
                                       |
                                       v
                          STAGING rows (import_rows)
                                       |  human review + confirm
                                       v
                                  Collections ──► Payments
```
**Changes vs. the proposed architecture (and why):**
1. **Staging area explicit** (`import_rows`): review edits and rejections must not touch live collections; guarantees the reliability requirement.
2. **Parsers first, AI/OCR as fallback** inside the processing layer, not parallel peers (see Q2).
3. **Job queue** between API and worker so slow PDF/OCR work doesn't block requests. In MVP this can be a DB-backed queue (no extra infra).
4. **Payment page served by the same API** (public, token-scoped endpoint), not by a separate system; the static frontend renders it. It reads the **payment_request snapshot**, not live collection/settings rows (Revision 1). The only live lookups are request status (ACTIVE/REVOKED) and collection status (PAID/CANCELLED) to show an inactive/paid banner.

## H. Module Architecture
| Module | Responsibility | Depends on |
|---|---|---|
| Auth | identity, sessions | Auth provider |
| Dashboard | read-only aggregates | Collections, Payments |
| Upload | validate + store file, create batch, enqueue job | Storage, Queue |
| Processing | file → staged rows (pure function of file + mapping rules) | Parsers, AI/OCR adapter |
| Review | edit/accept/reject staged rows; confirm import transaction | Staging, Collections |
| Collections | domain rules, status derivation, edit/cancel | DB |
| Payments | record/void payments; recompute outstanding | Collections |
| Payment Page | token resolution, public read model (minimal fields) | Collections, Settings |
| Notifications | `send(channel, to, template, vars)`; provider adapters; send log | Providers |
| Settings | payment method config | DB, Storage (QR) |
| Audit | append-only events | all write paths |

## I. Data Model
Principle: add a table only if it carries state that can't live elsewhere.

**employers** — id, name, email, phone, created_at *(workspace + login owner; the tenant root)*
**customers** — id, employer_id, name, phone (E.164), email, created_at. Unique (employer_id, phone) when phone present. *(Separate from collections so one customer with many invoices is one row and the phone is stored once.)*
**import_batches** — id, employer_id, filename, file_type, file_hash (SHA-256), storage_key, uploaded_by, uploaded_at, status (UPLOADED/PROCESSING/READY_FOR_REVIEW/IMPORTED/FAILED/DISCARDED), counts, error_message. *(Answers Q18: a source-file entity IS needed — it carries processing status, the file hash for duplicate-upload detection, and the review session.)*
**import_rows** — id, batch_id, row_number, raw_data (JSON), mapped_data (JSON), issues (JSON: level/code/field/message), decision (PENDING/ACCEPTED/REJECTED), duplicate_of_collection_id. *(Staging; deleted/archived after import.)*
**collections** — id, employer_id, customer_id, amount_due (numeric(12,2), immutable original), due_date, reference, description, import_batch_id (nullable → source), status, cancelled_at, created_at, updated_at. `public_token` lives on payment_requests, not here.
**payment_requests** — *(REVISED, see "Revision 1" below)* id, employer_id, collection_id, token_hash (hash only, never the raw token), status (ACTIVE/REVOKED), supersedes_request_id (nullable), created_at, revoked_at, revoked_reason, first_viewed_at, last_viewed_at, **plus an immutable snapshot of everything customer-facing**: snapshot_customer_name, snapshot_amount_requested, snapshot_reference, snapshot_employer_display_name, snapshot_upi_id, snapshot_upi_number, snapshot_qr_storage_key, snapshot_bank_name, snapshot_account_name, snapshot_account_number, snapshot_ifsc, snapshot_enabled_methods. Snapshot columns are write-once at creation (enforced in the API; no update path).
**payments** — id, collection_id, amount, payment_date, payment_method (UPI/BANK/CASH/OTHER), reference_utr, status (RECORDED/VERIFIED/VOID), voided_reason, created_by, created_at, updated_at.
**payment_settings** — id, employer_id (unique), upi_id, upi_number, qr_code_storage_key, bank_name, account_name, account_number, ifsc, enabled flags per method, display_name.
**notifications** — id, collection_id, payment_request_id, channel (WHATSAPP/SMS/MANUAL), to_phone, status (QUEUED/SENT/FAILED), provider, provider_message_id, error, created_at. *(Needed: audit of what was sent, to whom, and retry/failure visibility.)*
**audit_events** — id, employer_id, actor, entity_type, entity_id, action, details (JSON), created_at. Append-only.

Relationships: employer 1─* customers, batches, collections, settings(1), audit; customer 1─* collections; collection 1─* payments, payment_requests, notifications; batch 1─* import_rows, 0..* collections.

**Field classification (canonical record):**
| Field | Class | Reasoning |
|---|---|---|
| customer_name | **Required** | cannot demand money from nobody |
| amount_due | **Required**, >0 | core fact |
| phone | Optional at import; **required to send via WhatsApp/SMS** | file may lack phones (Q5); link can still be copied |
| email | Optional | not used for sending in MVP |
| due_date | Optional | missing → warning; no overdue tracking for that row |
| reference | Optional | but used as duplicate signal; warn if missing |
| description | Optional | |
| source_file | **Derived** (batch id) | never typed by user |
| status, outstanding | **Derived** | outstanding = amount_due − Σ verified payments |

## J. Collection Lifecycle
Original states are close; recommended change: **store only `PENDING`, `SENT`, `PAID`, `CANCELLED`; derive the rest.**
- `PAYMENT_PENDING` → dropped as a stored state (you can't know the customer is "paying"; it'd be a guess). Replace with derived flag **PARTIALLY_PAID** (0 < verified < due).
- `OVERDUE` → derived (due_date < today AND outstanding > 0), shown as a badge/filter. Stored overdue goes stale without a cron job.
- **PENDING** — imported, no request sent. → SENT (first successful send / link marked shared), → CANCELLED.
- **SENT** — at least one request delivered/shared. → PAID (outstanding hits 0), → CANCELLED. Re-send allowed.
- **PAID** — outstanding = 0. → back to SENT/PENDING if a payment is voided (recomputed).
- **CANCELLED** — terminal-ish; links revoked; payments retained; reopening allowed by employer (audited).
Status is recomputed from payments inside the same transaction as every payment change.

**Q11 (edit after sent):** allowed, but changing `amount_due` or `customer` after a request is sent shows a warning, writes an audit event. **Existing payment requests are snapshots and do NOT change** (Revision 1); the warning offers "Revoke & regenerate request" so the customer sees the corrected figures only by explicit employer action. Reference/description/due_date edits are free. If payments exist, amount_due can't go below verified payments.

## K. Payment Lifecycle
Instructions (settings + page) are separate from verification (payment records).
- **V1 (REVISED): one employer action — "Record Payment" = confirm/verify.** The employer has already checked their bank/UPI app; submitting the form creates the payment directly with status **VERIFIED**. The UI has no separate Recorded→Verified step.
- **Extensibility:** `payments.status` enum keeps a reserved **RECORDED** value (unused in V1 UI, never counted toward outstanding). A future two-step flow = create as RECORDED, add a "Verify" action, plus `verified_by`/`verified_at` columns (added then, not now). No data migration needed for V1 rows. Only VERIFIED counts toward outstanding.
- **VOID** — correction mechanism; never delete (Q10: accidental mark-as-paid is fixed by voiding with a reason; status recomputes; audited).
- Partial payments: supported by data model (many payments per collection; amount ≤ outstanding). V1 UI: single "Record payment" form prefilled with full outstanding, editable amount.
- Overpayment: block in MVP (amount ≤ outstanding), note in future.
- Outstanding = amount_due − Σ(VERIFIED amounts).

## L. File Processing Architecture
1. **Upload** → size/type/magic-byte check → store private → hash → create batch → enqueue.
2. **Detect** by content, not extension (zip signature for xlsx/docx, OLE for xls, `%PDF`, text/CSV sniff).
3. **Extract** (deterministic first):
   - xlsx/xls/csv: tabular parse; detect header row (skip title rows), pick sheet(s), handle merged cells.
   - docx: extract tables first; else paragraphs.
   - PDF: text-layer table extraction; if no text layer → OCR path.
4. **Interpret**: header synonym dictionary (exact/fuzzy) maps columns → canonical fields, with confidence. If confidence low or columns ambiguous → **AI-assisted mapping** (sends only headers + a few sample rows, not whole file) and the **user confirms the column mapping** at the review step.
5. **Normalize**: trim; names title-cased preserving original; amounts (strip ₹/Rs/commas, lakh formats, parentheses/negatives); phones → E.164 (+91 default, strip 0/spaces); dates → ISO; reference trimmed.
6. **Validate** (§ below) → store `issues` per row.
7. **Review** → human decisions → **Confirm** → single transaction: upsert customers, insert collections, mark batch IMPORTED, write audit event.

**Validation model:**
- **Hard error (blocks import until fixed or row rejected):** missing customer; missing/non-numeric/≤0 amount; unparseable amount.
- **Warning (importable after acknowledge):** invalid/missing phone; invalid/ambiguous date; missing reference; possible duplicate; suspiciously large amount (> 10× batch median); low OCR/AI confidence.
- **Info:** value normalized (e.g., "Rs 1,200" → 1200.00), phone reformatted, customer matched to existing.
Rows with any AI/OCR-sourced value are flagged "needs review" regardless of validity.

**Q&A on processing:**
- **Q2** Deterministic first: cheap, free, reproducible, auditable. AI only for (a) ambiguous column mapping, (b) unstructured PDF/Word text, (c) OCR. AI output is always a *proposal*.
- **Q3 Scanned PDFs:** detect no text layer → OCR → all rows forced into "needs review" with confidence; employer sees source page snippet side by side (Stage 2). Offer to reject and re-upload a cleaner file. Treat as best-effort in MVP.
- **Q4 Multiple customers in one PDF:** table-extraction first; else AI segments into records. Each record becomes a row; unclear page/section → single row with a warning. Never merge across customers silently.
- **Q5 No phones:** import allowed (warning). Collection gets link-copy only; "Send" disabled until phone added; bulk "add missing phones" filter in Collections.
- **Q1 File storage:** keep original files in private storage for a bounded retention (suggest 90 days after import, then delete file but keep batch metadata + hash). Reason: re-processing and dispute resolution without hoarding customer data. Failed/discarded batches purged after 7 days.

## M. Notification Architecture
```
Collections ─► NotificationService.send(request) ─► Channel Router
                                                  ├─ WhatsAppProvider (interface)
                                                  ├─ SmsProvider (interface)
                                                  └─ ManualProvider (deep link / copy)
```
Interface: `send({channel, to, templateKey, variables}) → {status, providerMessageId}`. Collection code only creates a `notifications` row and calls the service. Provider selection by config.
**MVP recommendation: Manual fallback first** — "Send via WhatsApp" opens `https://wa.me/<phone>?text=<prefilled message with link>` and SMS opens `sms:` link; employer taps send from their own device. Zero cost, no WhatsApp Business approval/template wait (WhatsApp API requires approved templates + Meta business verification; India SMS requires DLT registration). Interface is built so a paid provider (e.g., a WhatsApp Business API vendor or SMS gateway) can drop in later. Tradeoff: no delivery receipts and no bulk send in MVP; employer must tap per customer (acceptable for MVP; revisit if volume is high — Open Question).

## N. Security Model
- **Authn:** managed auth provider (hashed passwords, rate-limited login, session/JWT expiry, HTTPS-only cookies/tokens); optional MFA later.
- **Authz:** every query filtered by `employer_id` from the authenticated session (never from request body); enforce in API layer **and** DB row-level security if Postgres/Supabase. Use UUIDs for internal IDs.
- **Payment links:** 128-bit+ CSPRNG token (≥22 URL-safe chars), stored hashed; page returns only: customer name, outstanding, reference, payment methods, employer display name. No internal IDs, no other invoices. Rate-limit by IP; `noindex`, `Referrer-Policy: no-referrer`; revocable; generic 404 for invalid/revoked (no enumeration). Mask account number partially? — show fully (customer needs it) but only the enabled methods.
- **File uploads:** extension + magic-byte match; size cap; reject macros (.xlsm/.docm); parse in isolated worker with time/memory limits; zip-bomb/decompression guard; files stored private, served only via short-lived signed URL; never executed; strip formulas (treat cells as values, defend against CSV/formula injection when displaying/exporting).
- **API:** server-side validation of all input; parameterized queries; CORS locked to frontend origin; CSRF protection if cookies; size limits.
- **Sensitive data:** minimal PII; no secrets/PII in logs; payment page leaks nothing beyond need.
- **Secrets:** env vars on backend only; `.gitignore` + secret scanning in GitHub; frontend has only public anon/config values.
- **HTTPS:** enforced everywhere, HSTS.
- **AI/OCR privacy:** document that file contents go to a third party; send minimum text; choose provider with no-training-on-data terms; configurable off.

## O. Error Handling
| Failure | Behavior |
|---|---|
| Unsupported type | Reject: "We couldn't process this file. Supported formats are Excel, CSV, PDF and Word." |
| Corrupt/password-protected file | Batch FAILED with specific message; no side effects |
| File too large | Reject pre-upload with limit shown |
| No recognizable columns | Show column-mapping UI instead of failing |
| Zero valid rows | Batch READY with 0 ready; explain; allow discard |
| Worker crash/timeout | Batch FAILED/retry; live data untouched |
| OCR/AI unavailable | Fall back to deterministic result or fail gracefully with "try Excel/CSV" |
| Confirm import fails mid-way | Transaction rollback; batch stays READY_FOR_REVIEW |
| Double-click confirm | Idempotent: batch status check + lock |
| Notification fails | Notification FAILED + visible retry; collection status unchanged until SENT |
| Invalid/revoked/paid link | Friendly page: "This payment request is no longer active. Contact [employer]." (paid → "Payment received") |
| Payment > outstanding / negative | Blocked with message |
| Session expired mid-review | Review state persisted server-side; resume after login |

## P. Duplicate Handling
Two levels, kept simple:
1. **Same file re-upload:** SHA-256 match on a prior batch → warn "This exact file was imported on <date>. Import anyway?" (default: cancel).
2. **Row-level:** match against existing collections (same employer) by key — if `reference` present: (customer, reference); else (customer, amount_due, due_date). Customer matching by phone, else normalized name. Duplicates inside the same file are flagged too.
Result: row flagged **Possible duplicate** (warning) with link to the existing record; default decision = reject; employer can override ("import anyway").
**Q7 Corrected file re-upload (REVISED):** V1 has **no automatic "Update Existing" reconciliation**. When a row matches an existing collection, the employer gets three per-row actions: **Skip** (reject row; default), **Import Anyway** (creates a new collection; audited as employer-overridden duplicate), **Review Existing** (opens the existing collection read-only in a side view so they can compare, then choose Skip/Import Anyway; any correction is made by editing the existing collection manually). Changed amount/date vs. the existing record is shown as an info note in the comparison, nothing more.

## Q. Audit Trail
Single append-only `audit_events` table, written in the same transaction as the change. Events: file_uploaded, import_confirmed (counts), collection_edited (before/after of changed fields), collection_cancelled/reopened, payment_request_created/revoked, notification_sent/failed, payment_recorded, payment_verified, payment_voided (reason), settings_changed (field names only, not values). Shown as a simple "History" list on a collection. No diff viewer, no export in MVP. **Q14 minimum:** who, what, when, before/after for money fields.

## R. Device & Deployment Architecture
- **PWA is appropriate:** one codebase, installable on Android/iOS/desktop, works over HTTPS, no app-store review. Limits: iOS push/offline are weak — irrelevant here because the app needs network and notifications aren't push-based. Native wrapping (Capacitor etc.) remains possible later.
- **Hosting split:** *Frontend hosting* = static files only (HTML/JS/CSS) → GitHub Pages is fine. *Backend* = a separate service holding API, DB, storage, worker, secrets. GitHub Pages cannot run server code, hide secrets, or store data.
- Cross-origin: frontend on `*.github.io` (or custom domain), API on its own HTTPS domain; CORS restricted. Custom domain recommended so payment links look trustworthy (`pay.yourdomain.com`), and because GitHub Pages SPA routing for `/pay/<token>` needs a 404.html fallback or hash/query routing (Stage 2/3 detail).
- Payment page is part of the same static app and fetches data from API with the token.

## S. Technology Stack Recommendation
Priorities: simple, cheap, maintainable, no lock-in.
- **Frontend:** React + TypeScript + Vite, responsive, PWA manifest/service worker (minimal), deployed to GitHub Pages via GitHub Actions. (Alternative: Svelte; React chosen for ecosystem/hiring.)
- **Backend:** Python **FastAPI** — strongest ecosystem for Excel/PDF/Word parsing (openpyxl, pandas, pdfplumber, python-docx), OCR, and AI SDKs; worker shares the same codebase. Hosted on a low-cost container host (Render/Fly/Railway-class; free/low tier acceptable for pilot).
- **Database:** PostgreSQL (managed; Supabase/Neon free tier OK). Standard SQL, portable.
- **Auth:** managed provider (Supabase Auth or similar) to avoid hand-rolling credentials; JWT verified by API.
- **File storage:** S3-compatible private bucket (Supabase Storage / Cloudflare R2) behind a `StorageService` interface.
- **Queue:** DB-backed job table + one worker process (no Redis/Celery in MVP).
- **OCR/AI:** pluggable adapter; start with Tesseract (free) for OCR and an LLM API (Claude via API) only for ambiguous mapping/unstructured text; behind a feature flag and cost cap.
- **Notifications:** Manual provider first; adapters stubbed for later.
- **Why not "Supabase-only/serverless functions"?** Possible and cheaper to run, but Python parsing libs and long-running OCR jobs fit a real worker better. Revisit at Stage 3 if simplicity wins; that choice doesn't change Stage 1 design.

## T. MVP Scope
**MUST HAVE:** login; dashboard (5 metrics); upload xlsx/xls/csv/pdf/docx; deterministic parsing + field synonym mapping; column-mapping confirmation when unsure; normalization + hard/warn/info validation; review screen with edit/accept/reject/confirm; collections list/detail/search/filter; cancel/edit rules; payment settings (UPI/UPI number/QR/bank); per-collection secure link; manual WhatsApp/SMS send + copy link; public payment page; record/verify/void payment; derived outstanding & statuses; duplicate detection (file hash + row key); audit events; responsive PWA; HTTPS/secrets hygiene.
**MVP SCOPE ADJUSTMENTS (Revision 1):** payment requests are immutable snapshots; single-step payment recording (status VERIFIED, RECORDED reserved); PDF kept in MVP with the input tiers defined in Revision 1; duplicates handled by Skip / Import Anyway / Review Existing only; manual WhatsApp/SMS deep links only.
**OUT OF SCOPE:** customer "I've Paid"/UTR submission; automatic Update-Existing reconciliation; automated WhatsApp/SMS provider; two-step verification UI; customer login/dashboard; accounting/GST; multi-currency; bank reconciliation; payment gateway; recurring/subscriptions; advanced analytics; native apps; Google Sheets API; roles/permissions; chatbot; automated escalation/reminders; bulk automated sending; invoice PDF generation; overpayment handling; multi-user per employer.
**Disagreements/flags on the brief (explained, not silently changed):** (1) PAYMENT_PENDING and OVERDUE removed as stored states (derived instead); (2) a separate `import_batches` table is added because file hash/status/review state need it; (3) `payment_requests` and `notifications` tables added; (4) scanned-PDF OCR is marked best-effort, not guaranteed; (5) supporting PDF/OCR in MVP is the highest-risk item — consider shipping Excel/CSV/Word first and PDF as a fast-follow (decision requested).

## U. Future Expansion
Automated send via WhatsApp/SMS provider + delivery receipts; scheduled reminders; partial-payment UI; customer "I've paid" with UTR submission; multi-user employers & roles; Google Sheets sync; payment gateway/UPI intent with webhooks; reconciliation via bank statement import; reporting/export; native wrappers; multi-currency; customer statements.

## V. Risks & Design Concerns
1. **Extraction accuracy (PDF/Word/scanned)** — mitigated by mandatory review; risk of "review fatigue" leading to blind confirm.
2. **Wrong-person payment demand** — wrong phone/customer match; mitigate with phone validation, preview message before send.
3. **Fraud/phishing perception** — payment page showing bank details from a link; mitigate with custom domain, employer name, clear branding; employer-controlled settings change should be audited (attacker-changed UPI = diverted funds). Consider re-auth to change payment details.
4. **Payment settings changes (Q12, REVISED):** requests are snapshotted, so a settings change does NOT alter existing links. Risk: a customer pays old/compromised details from a stale link. Mitigation: on saving settings, show "N active payment requests still use the previous details" with a one-click **Revoke & regenerate** for them (explicit action, never automatic); audit the change; require re-auth to change payment details.
5. **Expired/cancelled links (Q13):** cancelled → revoked, page shows inactive message; paid → "received". No auto-expiry in MVP.
6. **WhatsApp/SMS regulation & cost** — template approval, DLT in India; manual fallback avoids it initially but limits scale.
7. **AI/OCR cost, latency and data privacy.**
8. **GitHub Pages SPA routing & custom domain/CORS** for payment links.
9. **PII/DPDP-type compliance** — retention, deletion on request; define retention policy.
10. **Manual verification burden** — no reconciliation means employer cross-checks bank statement by hand.
11. **Multi-tenant leakage** — one missing `employer_id` filter = data breach; mitigate with RLS + tests.
12. **Free-tier hosting limits** (cold starts, storage caps).

**Q9 partial payment:** employer records the received amount; status stays SENT with PARTIALLY_PAID badge; the page now shows the reduced outstanding with "Paid so far"; no new link needed.
**Q15 multi-employer minimum:** `employer_id` on every table + server-derived tenant context + RLS + per-employer settings and storage prefixes — already in this design.

## W. Open Questions (need your decision)
**Resolved by your review (Revision 1):** manual WhatsApp/SMS deep links; single-step payment verification; no customer "I've paid"; PDF + OCR stay in MVP (OCR = best-effort + mandatory review); Skip / Import Anyway / Review Existing only; multi-tenant backend retained; snapshotted payment requests.

**Still open (my defaults apply if you don't object):**
1. **File retention** — default 90 days after import, then original deleted (metadata + hash kept). Is third-party AI/OCR processing of customer data acceptable? (default: yes, minimal data, feature-flagged.)
2. **Market** — default India/INR only (phone, UPI, IFSC, DD/MM/YYYY).
3. **Link expiry** — default none (revoked on cancel/paid/regenerate); field `expires_at` reserved.
4. **Employer login** — default email + password via managed auth.
5. **Expected scale** (rows/file, files/month) — default ≤2,000 rows, ≤10 MB.
6. **Snapshot amount behavior after partial payment** — default: the page shows the snapshot "requested amount" plus a live status banner only for PAID/CANCELLED; employer regenerates the request to ask for the reduced balance. Confirm.

---

# FINAL STAGE 1 DELIVERABLE

### 1. Final MVP Definition
A responsive PWA where a single employer uploads a collection file (Excel/CSV/Word/PDF), reviews and corrects the system-extracted records, confirms the import, and sends customers secure payment links (via WhatsApp/SMS deep links) that show amount due and employer-configured payment instructions (UPI/QR/bank). The employer verifies payments manually and records them; outstanding amounts and statuses update from recorded payments. No customer accounts, no gateway, no auto-sending.

### 2. Final Architecture
Static PWA (GitHub Pages) → FastAPI backend (auth-verified, tenant-scoped) → Postgres + private object storage + DB-backed job queue → processing worker (deterministic parsers → AI/OCR fallback → normalize → validate → **staging**) → human review → collections/payments. Notification service with provider adapters (Manual now). Public token-scoped payment page. Audit events written transactionally. (Diagram in §G.)

### 3. Final Data Model
employers · customers · import_batches · import_rows (staging) · collections · payment_requests · payments · payment_settings · notifications · audit_events. All tenant tables carry `employer_id`. Outstanding and PARTIALLY_PAID/OVERDUE are derived. (Fields in §I.)

### 4. Final User Flow
Employer logs in → uploads file → system parses to staged rows → employer reviews (errors/warnings/duplicates) → confirms import → collections created (PENDING) → employer generates link → sends via WhatsApp/SMS (manual deep link) → collection SENT → customer opens `/pay/<token>`, sees name/amount/reference/methods → pays externally → employer verifies in bank/UPI app → records payment → outstanding recalculated → PAID at zero (or partially paid).

### 5. Technology Recommendation
React+TS+Vite PWA on GitHub Pages; FastAPI (Python) API+worker; PostgreSQL (managed); managed Auth; S3-compatible private storage; DB-backed queue; openpyxl/pandas/pdfplumber/python-docx + Tesseract; LLM API only as flagged fallback; manual notification provider with adapter interfaces.

### 6. Risk Register (top)
| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Extraction errors reach customers | High | staging + mandatory review + AI flagged rows + message preview |
| 2 | Payment-detail tampering/diversion | High | auth hardening, re-auth on settings change, audit, notify on change |
| 3 | Cross-tenant data leak | High | RLS + server-derived tenant + tests |
| 4 | OCR/PDF scope creep | Med | best-effort, phased |
| 5 | WhatsApp/SMS compliance & cost | Med | manual fallback first |
| 6 | Token link leakage/guessing | Med | CSPRNG hashed tokens, rate limit, revoke |
| 7 | PII retention/AI data sharing | Med | retention policy, minimal data to AI, feature flag |
| 8 | GitHub Pages routing/CORS/domain | Low | custom domain, routing strategy in Stage 3 |

### 7. Decisions Required From Me
See §W (10 items; items 1, 2, 3, 4, 5 are the ones that most change scope).

### 8. Stage 2 Readiness Checklist
```
[READY]          Actors and core flow
[READY]          Module list and MVP boundaries
[READY]          Data model and canonical record
[READY]          Collection & payment lifecycle
[READY]          Security model and payment-link approach
[READY]          Architecture and hosting split
[READY]          Notifications: manual WhatsApp/SMS deep links
[READY]          PDF/OCR scope and mandatory-review rule
[READY]          Payment verification: single-step, extensible
[READY]          Payment request snapshot model
[READY]          Duplicate handling: Skip / Import Anyway / Review Existing
[READY]          Multi-tenant-ready backend, single-workspace UI
[NEEDS DECISION] Retention + third-party AI data policy (default proposed)  — W1
[NEEDS DECISION] Market/currency, link expiry, login method (defaults proposed) — W2–W4
[NEEDS DECISION] Snapshot amount after partial payment (default proposed)   — W6
[NOT READY]      Screen-level UI specs (intentionally deferred to Stage 2)
```

---

---

# PART 2 — APPROVED AMENDMENT: REVISION 1 (verbatim)

# REVISION 1 — Changes requested in review (supersedes earlier text where they conflict)

## R1. Updated Architecture
Unchanged shape (see §G) with these deltas:
- **Payment page reads the `payment_requests` snapshot**, not live collection/settings. Live lookups limited to request status and collection PAID/CANCELLED.
- **QR snapshot = immutable copy.** `snapshot_qr_storage_key` points to a copy of the QR image made at request creation (content-addressed key, e.g. by hash), so replacing/deleting the QR in Settings cannot alter or break existing requests. Retained until the request is deleted per retention policy.
- **Notifications = ManualProvider only** (wa.me / sms: deep links + copy link). Provider interface retained; no paid/automated provider integrated.
- **Multi-tenant:** `employer_id` on all tenant tables, derived from the session server-side, enforced by API + DB row-level security. UI shows a single workspace; no tenant switcher.
- **Processing tiers (PDF/OCR):**
  | Input | Support level | Review |
  |---|---|---|
  | Excel (.xlsx/.xls), CSV | Primary structured path | Standard validation review |
  | Word (.docx) | Supported (tables first, then text) | Standard review; text-extracted rows flagged "needs review" |
  | Text-based PDF | Supported (table extraction, else text/AI segmentation) | Standard review; AI-segmented rows flagged |
  | Scanned/image PDF | **Best-effort OCR** | **Every OCR row = "needs review", must be explicitly accepted; no "accept all" bulk shortcut; import button blocked while any OCR row is unreviewed** |
  Rule enforced server-side: `import_rows.source_method = OCR` ⇒ `requires_review = true` ⇒ cannot be imported until `decision = ACCEPTED` by a human action. The client cannot override it.

## R2. Updated Data Model (delta from §I)
- **payment_requests** — expanded with snapshot columns (listed in §I). Why: a request is a *document sent to a customer*; once sent, what the customer was told must not drift. Why not JSON blob: columns are simpler to query, audit and constrain; blob is acceptable alternative at Stage 3 if preferred. Why employer_id here: RLS without joins.
- **payments** — `status` enum: `VERIFIED` (V1 default), `VOID`, plus reserved `RECORDED`. No `verified_by/verified_at` yet (added with a future two-step flow). `created_by` serves V1.
- **import_rows** — add `source_method` (TABLE/TEXT/AI/OCR), `requires_review` (bool), `duplicate_action` (NONE/SKIP/IMPORT_ANYWAY) replacing any update-existing notion; `duplicate_of_collection_id` retained.
- **collections / customers / employers / payment_settings / notifications / import_batches / audit_events** — unchanged. `payment_settings` remains the *editable current* config; history lives in snapshots and audit events.
- No new tables added.

Relationships (final): employer 1─* {customers, import_batches, collections, payment_requests, payments(via collection), notifications, audit_events}, employer 1─1 payment_settings; customer 1─* collections; collection 1─* {payments, payment_requests, notifications}; batch 1─* import_rows; batch 1─* collections (source).

## R3. Updated Payment-Request Model
- **Create:** employer clicks "Generate request" → API (in one transaction) copies from the live collection + payment_settings: customer name, amount requested (= current outstanding at that moment), reference, employer display name, UPI ID, UPI number, QR (copied file key), bank details, enabled methods; generates CSPRNG token, stores only its hash; writes audit event. The raw token is returned once to build the link (and can be re-displayed by regenerating — not recoverable from DB).
- **Immutable:** snapshot columns are never updated. Editing the collection or Settings afterward has no effect on existing requests.
- **Change = regenerate:** the only way to change what a customer sees is "Regenerate": new request with new token and fresh snapshot, old one set REVOKED (`supersedes_request_id` links them). Revoke alone (without regenerate) is also available.
- **Multiple active requests:** at most one ACTIVE request per collection (enforced by partial unique index) — keeps "which link is real?" unambiguous.
- **Customer page behavior:** ACTIVE → shows snapshot (name, requested amount, reference, employer name, enabled methods only). REVOKED → "This payment request is no longer active. Please contact <employer display name snapshot>." Collection PAID → "Payment received — thank you." CANCELLED → inactive message. Never exposes internal IDs or other invoices. Opening the page or tapping a UPI link changes nothing about payment status.
- **Staleness guard (employer side):** collection detail shows a "Request is out of date" badge when live amount/customer/reference differs from the snapshot, with the Regenerate action; Settings save shows the count of active requests using old details (see Risk #4). No automatic revocation.
- **Partial payment:** snapshot amount stays as requested; outstanding on the employer side reduces; employer may regenerate for the new balance (W6).
- **Q13 expired/cancelled:** cancelling a collection auto-revokes its active request (that is an explicit employer action). `expires_at` reserved, unused in V1.

## R4. Updated Payment Lifecycle
```
Instructions (snapshot on payment_request)   ≠   Verification (payments)
Customer opens page / taps UPI  →  NO state change
Employer checks bank/UPI app → "Record Payment" (amount, date, method, UTR optional)
        → payment created as VERIFIED (single action) → outstanding recalculated
Outstanding = amount_due − Σ payments where status = VERIFIED
Mistake → "Void payment" (reason required) → status VOID → outstanding recalculated → audited
```
Collection status transitions on each payment change (same transaction): outstanding = 0 → PAID; PAID + void → back to SENT (or PENDING if never sent); 0 < verified < due → PARTIALLY_PAID badge (derived). Validation: amount > 0 and ≤ outstanding; payment_date not in the future. Future two-step: new payments start RECORDED, "Verify" promotes to VERIFIED — no schema break.

## R5. Updated MVP Scope
**MUST HAVE (delta-adjusted):** everything in §T plus: snapshotted payment requests with revoke/regenerate and out-of-date indicator; single-step Record Payment (VERIFIED) with Void; PDF input in three tiers (text PDF supported; scanned best-effort OCR with mandatory per-row human acceptance); duplicate actions Skip / Import Anyway / Review Existing; manual WhatsApp/SMS deep-link sending.
**OUT OF SCOPE (added):** customer "I've Paid"/UTR; automatic Update-Existing reconciliation; automated WhatsApp/SMS provider; two-step verification UI; multi-workspace UI/tenant switcher; everything previously listed. No new features introduced beyond the above.

## R6. Updated Stage 2 Readiness Checklist
```
[READY]          Actors, flow, modules, MVP boundaries
[READY]          Data model incl. payment-request snapshot
[READY]          Collection & payment lifecycles (single-step verification)
[READY]          Payment request model (immutable, regenerate/revoke)
[READY]          File processing tiers and OCR mandatory-review rule
[READY]          Duplicate handling (Skip / Import Anyway / Review Existing)
[READY]          Notifications (manual deep links)
[READY]          Security model, multi-tenant isolation
[READY]          Architecture and hosting split
[NEEDS DECISION] File retention + third-party AI/OCR data policy (default: 90 days; allowed, minimal data) — W1
[NEEDS DECISION] Market/currency, link expiry, login method (defaults: India/INR, none, email+password) — W2–W4
[NEEDS DECISION] Snapshot amount after partial payment (default: regenerate to ask for balance) — W6
[NOT READY]      Screen-level UI specs (intentionally Stage 2)
```
Items marked NEEDS DECISION have safe defaults and do not block Stage 2 unless you object.

---

**STOP.** Not proceeding to Stage 2. Awaiting your review; will continue only after you say **"Stage 1 approved"**.

---

# PART 3 — SUBSEQUENT APPROVED AMENDMENTS (appended; historical text above is unchanged)

## 3.1 Stage 2 review corrections that amend Stage 1

Source: approved Stage 2 review ("Corrections Applied"); full UI specification in `docs/stage-2-ui-ux.md`.
The following text is reproduced unchanged from that approved document.

### Stage 2 review — corrections summary
All other Stage 2 content is unchanged. Only the sections below were edited.

| # | Correction | Where applied |
|---|---|---|
| 1 | **Active link can be copied/sent again later** without regenerating | New "Stage 1 adjustment" box below; S9 request section & actions; S8 row menu; S9b; §17; Journey B |
| 2 | **Explicit public-page precedence rule**; a revoked link never reactivates, even if the collection is later paid | S11 (new precedence table + states), S9d revoke note, Journey C |
| 3 | **Two employer-side concepts: "Out of date" vs "Balance changed"**; CTA "Regenerate for ₹6,000" | S8, S9, S9a, S9b, §16, §21, Journey E, visual badges |
| 4 | **No scope expansion** — listed decisions kept as-is | Nothing added; see checklist |


#### Amendment 3.1.1 — Token storage (Correction 1)

**Flagged Stage 1 adjustment (not silent).**
**Conflict:** Stage 1 §N / R3 say tokens are stored **hashed only** and the raw token is "returned once, not recoverable". That makes "Copy link later" impossible without creating a second request.
**Minimal adjustment (payment_requests only; no new table, no change to token randomness, snapshot, revocation, one-ACTIVE rule, rate limiting or public-page behavior):**
1. Keep the **lookup hash** of the token (used by the public page to find the request; the public page never needs the raw token stored).
2. **Additionally store the token encrypted** (application-level authenticated encryption, key held in backend secrets/KMS — never in the DB, repo or frontend). Conceptually one extra column on `payment_requests`: *encrypted token*.
3. **Retrieval is a dedicated, authenticated, tenant-scoped action** ("get link") that returns the link only for the caller's own **ACTIVE** request. The encrypted token and the link are **never** included in list/detail/collection/dashboard responses, logs, audit details, or the page DOM until the employer clicks Copy/WhatsApp/SMS (fetched on demand, held in memory, not persisted client-side).
4. **On revoke (or regenerate/cancel auto-revoke) the encrypted token is erased**; the lookup hash stays so the public page can still answer "inactive" for a revoked link. A revoked link can therefore never be shown again or reactivated.
5. Regenerate = new random token + new snapshot; old request revoked and its encrypted token erased. Still **only one ACTIVE request per collection**.
6. Security consequences accepted: a database + key compromise could reveal active links (each link exposes only a snapshot payment request, no account access). Mitigations: key separation, short-lived retrieval endpoint with rate limit, access limited to the owning employer, key rotation supported.
This is the **only** Stage 1 change introduced by this review; Stage 3 should treat it as an amendment to Stage 1 §N and R3.

*Distinction preserved:* **Original Stage 1** (§N): hashed token only. **Revision 1 R3**: raw token returned once, only hash stored. **Amendment 3.1.1** (this section, approved at Stage 2 review): lookup hash **plus** encrypted token for authenticated employer-side retrieval, ciphertext erased on revoke. **Implementation detail** (algorithms, columns, constraints, triggers) is recorded separately in `docs/adr/0001-token-storage.md` and is not part of this historical text.

#### Amendment 3.1.2 — Customer payment page precedence (Correction 2)

Evaluated top-down; first match wins:
  | # | Condition | Page shown |
  |---|---|---|
  | 1 | Invalid / unknown / malformed token | Generic **invalid-link** page |
  | 2 | Request is **REVOKED** | **Inactive** page |
  | 3 | Collection is **CANCELLED** | **Inactive** page |
  | 4 | Request ACTIVE **and** collection **PAID** | "**Payment received — thank you.**" |
  | 5 | Request ACTIVE **and** collection not PAID | The **immutable snapshot** (active payment page) |
  Consequences: a request that was explicitly revoked stays inactive **even if the collection is later paid** — it never becomes active again and never reveals payment details or "payment received". If a payment is voided and a PAID collection returns to unpaid, an *ACTIVE* (never-revoked) request goes back to showing its snapshot (rule 5). Employers who want a revoked-then-paid link to read "Payment received" cannot get that (by design); they simply don't revoke.

#### Amendment 3.1.3 — "Out of date" vs "Balance changed" (Correction 3)

Two separate employer-side concepts (UX terminology; the underlying snapshot model of Revision 1 is unchanged):
Both apply only to an **ACTIVE** request. Neither changes the request or the customer's link; nothing is revoked or regenerated automatically. They can show together.

**A. Out of date** (amber) — *customer-facing information* differs from the snapshot: customer name, reference, employer display name, or payment details (UPI ID, UPI number, QR, bank details, enabled methods).
- **On S9:** amber banner under header: "**This payment request is out of date.** Your customer's link still shows the original details." Request section tag **Out of date** and a **"What's different"** table: Item · Customer sees now · Current value (e.g., Reference INV-2041 → INV-2041-A; UPI ID acme@okaxis → acme@oksbi; Customer name changed). Also existing request status (Active, created date, last viewed). CTA **Regenerate request** (primary) with note "This will revoke the current link and create a new one." Alternatives: "Keep current request" (hides banner for this session; tag stays) and Revoke.

**B. Balance changed** (blue/info) — the **requested amount** differs from the current **outstanding** (partial payment recorded, payment voided, or collection amount edited).
- **On S9:** info banner: "**Balance changed.** The existing payment request still asks for ₹10,000.00. You can regenerate a new request for the remaining ₹6,000.00." with mini equation *Requested ₹10,000.00 · Received ₹4,000.00 · Remaining ₹6,000.00*. Primary CTA **"Regenerate for ₹6,000.00"**; secondary "Keep current request". If a void raises outstanding above the request, same banner with the new numbers ("…regenerate for ₹10,000.00"). If outstanding is ₹0 (PAID) the notice is not shown and no regenerate CTA exists.
- **If both apply:** two stacked notices share one CTA **"Regenerate request"**; the regenerate modal shows both groups in its diff (§15).

- **In S8 list:** Request column shows **Out of date** (amber) and/or **Balance changed** (blue) tags; both are filterable (Request filter).
- The snapshot model is unchanged: the customer keeps seeing the original requested amount and details until the employer regenerates/revokes.
- **Settings-driven (see §19):** after saving payment details, S10 shows an **outdated-requests panel**: "**14 active payment requests still use your previous payment details.**" Buttons: "Review requests" (opens S8 filtered `Request: Out of date`, with a "Regenerate…" multi-step) and "Dismiss for now". The list view for this filter allows opening each collection to regenerate individually (no bulk regenerate in V1; no new feature). The count stays visible on S10 and as a dot on the Settings nav item until zero.


## 3.2 Frozen product defaults (Phase 0 authorisation)

Source: owner instruction authorising Phase 0. These supersede the "default if you don't object" items listed under §W and in the Stage 2 readiness checklist (§8 / R6).

- Market: India
- Currency: INR
- Phone: India (+91)
- Login: email + password
- Payment-request expiry: none in V1
- File retention: 90 days after successful import
- Failed/discarded import files: 7 days
- Customer "I've Paid" / UTR submission: OUT OF SCOPE
- Payment gateway: OUT OF SCOPE
- Automated WhatsApp/SMS provider: OUT OF SCOPE
- AI: fallback only, feature-flagged and cost-capped
- Partial payment: the existing payment request remains an immutable snapshot; the employer can explicitly regenerate a new request for the remaining balance

## 3.3 Stage 3 implementation amendments (pointers only)

Approved with the Stage 3 plan; recorded in `docs/stage-3-implementation.md` §3.0 and `docs/adr/`:
A1 token stored encrypted + hash (see 3.1.1 / ADR 0001) · A2 hash routing for GitHub Pages (ADR 0002) · A3 DB-backed queue using `import_batches` (ADR 0003) · A4 staging columns required by Stage 2 review UX (ADR 0003) · A5 idempotency via client-supplied UUID primary keys (ADR 0003) · A6 employers provisioned by an operator script (ADR 0003) · A7 QR snapshot streamed by the API (ADR 0003).

## 3.4 Supersession index

| Earlier text (kept above, unchanged) | Superseded by | Status |
|---|---|---|
| §V "Q9 partial payment": page shows reduced outstanding "with Paid so far"; no new link | Revision 1 R3 / R4 and §3.2: the request never changes after generation; employer regenerates for the balance | **Superseded** |
| §I / §N / R3: token stored hashed only; raw token returned once, not recoverable | Amendment 3.1.1 (encrypted token + lookup hash; erased on revoke) | **Superseded** |
| §W Open Questions 1–10 | Resolved by Revision 1 ("Resolved by your review") and §3.2 frozen defaults | **Resolved** |
| §T / Final Deliverable "decisions required" and R6 readiness items marked NEEDS DECISION | §3.2 frozen defaults | **Resolved** |
| R3 "Q13 expired/cancelled" | Unchanged; precedence made explicit in 3.1.2 | Extended |
