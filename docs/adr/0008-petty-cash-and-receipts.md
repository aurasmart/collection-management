# ADR 0008 — Petty Cash and payment receipts

**Status:** Approved by the owner. Amends ADR 0006 for these two features only. ADR 0006's "no OCR/AI" list otherwise stands.

## What was added
1. **Petty Cash tab** (between Collections and Import). The employer uploads a payment receipt (UPI / NEFT / bank
   screenshot as PNG, JPG, WebP, or a PDF, max 5 MB). The server reads the text and **proposes** six fields:
   Transaction ID, Date, Payment to, Payment from, Remarks, Amount. The employer reviews and corrects them in a form;
   nothing is saved until **Save entry**. The receipt file is stored with the entry.
2. **Receipt on Mark as Paid.** The Mark-as-Paid dialog has an optional receipt picker (image or PDF). Mark as Paid works
   exactly as before without it. A receipt can also be attached, replaced, viewed or removed from the customer's page.

## Decisions
- **OCR is re-approved for Petty Cash only**, using the existing Tesseract provider (`OCR_ENABLED`, `app/modules/imports/ocr.py`)
  plus label-based regex parsing (`app/modules/petty_cash/parser.py`). Text-layer PDFs use the PDF text first and only OCR
  scans. No AI/LLM, no external service: the receipt never leaves our infrastructure.
- **Proposals only.** A field that cannot be found is empty; if no text can be read the form opens blank with a warning.
  A matching saved Transaction ID shows a "Possible duplicate" warning (it does not block saving).
- **Storage.** Original bytes in a new **private** bucket `receipts` (`RECEIPTS_BUCKET`), key `<employer_id>/…`, served only through
  authenticated endpoints (no public URL). The file type is judged from its bytes, never the name or declared type.
- **Data.** Migration `0005`: `collection_receipts` (one receipt per collection) and `petty_cash_entries`. Both have
  `employer_id`, RLS and a tenant policy; `employer_id` always comes from the verified JWT.
- **Retention.** Kept until the entry or the customer is deleted (the file is deleted with it). Not covered by the 90-day import-file rule.
- **Audit.** `receipt_attached`, `receipt_removed`, `petty_cash_created|edited|deleted`: ids and action only, never receipt text or amounts.
- **No recording of a payment.** A receipt is evidence kept next to the manual Mark as Paid; it is not verified and does not change status.

## Out of scope (unchanged)
Payment gateways, UPI APIs, automatic payment detection, partial payments, OCR/AI for anything else.
