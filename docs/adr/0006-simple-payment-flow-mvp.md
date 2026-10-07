# ADR 0006 — Simple payment-flow MVP (supersedes Stage 3 phases 2–6)

**Status:** Approved by the owner (re-scope after Phase 1). The Stage 1/2 documents are kept as history; where they
describe richer behaviour (staging pipeline, payment-request snapshots, encrypted tokens, partial payments, OCR, audit
history UI) this ADR is what is actually built.

## The whole flow
Employer uploads an .xlsx/.csv → reviews and fixes the rows → confirms → customers appear in **Collections** (Pending) →
**Generate Payment Page** gives each customer one link → employer sends it with a WhatsApp/SMS deep link or copies it →
the customer opens the page (no login), sees the amount and the company's UPI ID / general QR / bank details, pays
**outside** the app → the employer clicks **Mark as Paid** (and can undo with **Mark as Unpaid**).

## What exists, in a few bullets
- `customers` (name, phone) and `collections` (customer, amount, due date, reference, `status` PENDING|PAID,
  `payment_token`): **one customer row per imported line**, so editing a row never touches another row.
- `payment_token` = `secrets.token_urlsafe(16)` (128-bit), stored as is, unique. "Generate" is idempotent. No expiry, no revoke.
- The payment page reads **live** data (customer, amount, company settings). No snapshots.
- The public page and its QR are served by `GET /api/v1/public/pay/{token}[/qr]` through one read-only SQL function
  (`public_payment_page`, migration 0002). Disabled payment methods are returned as NULL, so they cannot leak.
- The QR is the **one general company QR** from Settings, streamed byte-for-byte. It is never generated per customer,
  never encodes an amount, and the customer enters the amount in their own UPI app.
- Public endpoints are rate limited in-process (`app/core/ratelimit.py`): 60 loads/min/IP, and 15 *misses*/min/IP to stop token guessing.
- Import is stateless: `preview` (parse + validate, nothing saved) → the browser edits → `validate` (re-check edited rows) →
  `confirm` (re-validates everything, then inserts all rows in one transaction). Nothing the browser sends is trusted.
- Audit events (names/ids/amounts only, never tokens): `import_confirmed`, `collection_edited`, `payment_page_created`,
  `marked_paid`, `marked_unpaid`.

## Deliberately NOT built
Payment gateway, UPI API/deep links, dynamic or per-customer QR, automatic payment detection, UTR/"I've paid", partial payments,
payment history/reconciliation, snapshots/encrypted tokens/token revocation, PDF/Word/OCR/AI, automated WhatsApp/SMS, customer
accounts, duplicate-import detection, Redis/Celery/queues.

## Left unused from earlier phases (not removed, nothing builds on them)
Tables `payment_requests`, `payments`, `import_batches`, `import_rows`, `notifications` and `app/core/crypto.py`.

## Known limits (accepted for this MVP)
- The token is stored in plain text; a database leak would reveal payment *instructions* (not accounts or logins).
- Rate limiting is per API process (fine for one instance).
- No duplicate-upload warning: uploading the same file twice creates the customers twice.
- Mark as Unpaid is a simple status correction; there is no record of who paid what or when beyond audit events.
