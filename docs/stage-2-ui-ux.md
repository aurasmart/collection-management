<!-- AUTHORITATIVE. Approved Stage 2 UI/UX specification (including 'Corrections Applied'). Do not change without explicit approval. -->

# STAGE 2 — UI/UX DESIGN SPECIFICATION

**Context.** Stage 1 is approved (architecture, data model, payment model, security, MVP scope all frozen). Stage 2 translates it into a screen-by-screen UI/UX spec for Stage 3. No code, components, APIs, DB, or deployment; no new features. Where ambiguity existed I used Stage 1 defaults (INR/India, email+password, no link expiry, 90-day retention, ≤2,000 rows/≤10 MB).

**Interpretation notes (no scope change):**
1. "Recent activity" on the dashboard = Stage 1's *Recent collections* list (last 10); no activity feed.
2. A small "Recent imports" list on the Upload screen is needed so a READY_FOR_REVIEW batch can be resumed after session expiry (Stage 1 §O). It is not a new module.
3. Within-file duplicates: Stage 1 defines "Review Existing" against existing collections. For within-file duplicates, "Review Existing" opens the *other incoming row* side by side (no existing collection exists yet). Same three actions only.
4. Stage 1 text in §V "Q9" still says the page shows reduced outstanding; the later Revision 1 rule governs: **the page never changes after generation**. This spec follows Revision 1.
5. Re-authentication (Stage 1 §V.3): changing payment details requires entering the account password in a modal (no new auth features).

---

## CORRECTIONS APPLIED (after Stage 2 review)
All other Stage 2 content is unchanged. Only the sections below were edited.

| # | Correction | Where applied |
|---|---|---|
| 1 | **Active link can be copied/sent again later** without regenerating | New "Stage 1 adjustment" box below; S9 request section & actions; S8 row menu; S9b; §17; Journey B |
| 2 | **Explicit public-page precedence rule**; a revoked link never reactivates, even if the collection is later paid | S11 (new precedence table + states), S9d revoke note, Journey C |
| 3 | **Two employer-side concepts: "Out of date" vs "Balance changed"**; CTA "Regenerate for ₹6,000" | S8, S9, S9a, S9b, §16, §21, Journey E, visual badges |
| 4 | **No scope expansion** — listed decisions kept as-is | Nothing added; see checklist |

### ⚠ STAGE 1 ADJUSTMENT — FLAGGED, NOT SILENT (Correction 1)
**Conflict:** Stage 1 §N / R3 say tokens are stored **hashed only** and the raw token is "returned once, not recoverable". That makes "Copy link later" impossible without creating a second request.
**Minimal adjustment (payment_requests only; no new table, no change to token randomness, snapshot, revocation, one-ACTIVE rule, rate limiting or public-page behavior):**
1. Keep the **lookup hash** of the token (used by the public page to find the request; the public page never needs the raw token stored).
2. **Additionally store the token encrypted** (application-level authenticated encryption, key held in backend secrets/KMS — never in the DB, repo or frontend). Conceptually one extra column on `payment_requests`: *encrypted token*.
3. **Retrieval is a dedicated, authenticated, tenant-scoped action** ("get link") that returns the link only for the caller's own **ACTIVE** request. The encrypted token and the link are **never** included in list/detail/collection/dashboard responses, logs, audit details, or the page DOM until the employer clicks Copy/WhatsApp/SMS (fetched on demand, held in memory, not persisted client-side).
4. **On revoke (or regenerate/cancel auto-revoke) the encrypted token is erased**; the lookup hash stays so the public page can still answer "inactive" for a revoked link. A revoked link can therefore never be shown again or reactivated.
5. Regenerate = new random token + new snapshot; old request revoked and its encrypted token erased. Still **only one ACTIVE request per collection**.
6. Security consequences accepted: a database + key compromise could reveal active links (each link exposes only a snapshot payment request, no account access). Mitigations: key separation, short-lived retrieval endpoint with rate limit, access limited to the owning employer, key rotation supported.
This is the **only** Stage 1 change introduced by this review; Stage 3 should treat it as an amendment to Stage 1 §N and R3.

---

## 1. INFORMATION ARCHITECTURE

```
PUBLIC (no login)
 ├─ /login                         Login
 └─ /pay/<token>                   Customer Payment Page  [CUSTOMER-FACING]
        states: active | revoked | paid | cancelled | invalid/unavailable

AUTHENTICATED (employer, single workspace)
 ├─ Dashboard                      /
 ├─ Collections                    /collections
 │    └─ Collection detail         /collections/:id   (modals: edit, request, send, payment, void, cancel, history)
 ├─ Upload                         /upload            (+ Recent imports)
 │    └─ Import flow (one batch)   /imports/:batch/processing
 │                                 /imports/:batch/mapping      (only if needed)
 │                                 /imports/:batch/review
 │                                 /imports/:batch/confirm
 └─ Settings                       /settings          (Payment details only)
```
- **Primary navigation (4 items):** Dashboard · Collections · Upload · Settings.
- **No secondary navigation.** Import steps use a step indicator (Upload → Processing → [Mapping] → Review → Confirm), not menu items. Collection detail sections are tabs/anchors inside the page (Overview · Payments · Payment request · History).
- **Header (desktop & mobile):** product name/logo (left), workspace/employer display name (center-left on desktop; hidden on mobile), account menu (right: employer email, "Sign out"). No tenant switcher.
- **Mobile navigation:** fixed bottom tab bar with the same 4 items (icons + labels); header shows page title and account menu. Import flow hides the bottom bar and shows a top step bar with Back.
- **Desktop navigation:** left sidebar (≥1024px), collapsed to icon rail at 768–1023px (tablet), bottom bar below 768px.
- **Customer-facing:** only `/pay/<token>`. Standalone layout: no employer navigation, no links to the app.
- **Auth guard:** any authenticated route without a session → /login?next=<route> (after login return to `next`).

## 2. DESIGN PRINCIPLES
1. **Money is always unambiguous.** Every amount shows ₹, Indian digit grouping (₹1,25,000.00), and a label saying *what* it is (Due / Paid / Outstanding / Requested). Never show a bare number.
2. **Nothing goes out unreviewed.** Imports require explicit review; sending requires a preview of exactly what the customer sees and a deliberate confirm. No "send" action exists on any unreviewed or imported-but-unconfirmed data.
3. **Make the safe path the default.** Duplicate default = Skip; OCR rows default = Not accepted; import button disabled until blockers cleared; payment default amount = outstanding.
4. **Show consequences before irreversible-ish actions.** Void, cancel, revoke, regenerate, import confirm each state the effect in plain words ("Outstanding will change from ₹6,000 to ₹10,000").
5. **Status is visible and honest.** One status badge per collection plus derived indicators (Overdue, Partially paid). Opening a page or tapping UPI never implies payment; the UI says so.
6. **Fewest clicks for the main loop.** Upload→Review→Confirm in one linear flow; Collection detail holds every per-collection action; Record Payment is ≤3 taps.
7. **Mobile-first for employer tasks.** Tables become cards; sticky primary action bars; 44px targets.
8. **Plain, calm, professional.** Neutral surfaces, one accent color, color never the only signal.

## 3. SCREEN INVENTORY
| ID | Screen | Access |
|---|---|---|
| S1 | Login | Public |
| S2 | Dashboard | Employer |
| S3 | Upload (+ Recent imports) | Employer |
| S4 | Processing | Employer |
| S5 | Column Mapping | Employer (conditional) |
| S6 | Import Review (table, row drawer, OCR, duplicates) | Employer |
| S6a | Duplicate comparison panel | Employer |
| S7 | Import Confirmation | Employer |
| S8 | Collections list | Employer |
| S9 | Collection detail (+ History tab) | Employer |
| S9a | Edit collection (modal) | Employer |
| S9b | Generate / Regenerate request (preview modal) | Employer |
| S9c | Send request (WhatsApp / SMS / Copy link) | Employer |
| S9d | Revoke request (modal) | Employer |
| S9e | Record Payment (modal/sheet) | Employer |
| S9f | Void Payment (modal) | Employer |
| S9g | Cancel / Reopen collection (modal) | Employer |
| S10 | Payment Settings (+ re-auth modal, outdated-requests panel) | Employer |
| S11 | Customer Payment Page (6 states) | Public, customer-facing |
| S12 | Global: session-expired modal, 404 (employer), offline banner | Employer |

---

## 4. SCREEN SPECIFICATIONS

Conventions used below: **Money** = `₹` + Indian grouping + 2 decimals. **Dates** = `DD MMM YYYY` (e.g., 15 Oct 2026). **Required** marked `*`. Inline validation runs on blur and on submit; errors appear under the field, in text + icon, and the first invalid field gets focus on submit. Toasts auto-dismiss in 5s (errors persist until dismissed). Global patterns are defined in §24 and not repeated in prose.

### S1 — Login
- **Purpose:** authenticate the employer. **Access:** public. **Entry:** direct URL, auth-guard redirect, session expiry, sign out.
- **Layout:** centered card (max 400px) on neutral background; logo, title "Sign in", form, footer text "Need help? Contact your administrator." (no registration/forgot-password beyond Stage 1: *password reset exists in Stage 1 §E.1* → a "Forgot password?" text link opens a one-field email form that shows "If this email is registered, a reset link has been sent." Reset-password page: new password + confirm; same rules.)
- **Fields:**
  | Label | Placeholder | Req | Validation | Example |
  |---|---|---|---|---|
  | Email* | name@company.com | Yes | valid email format, trimmed | ops@acme.in |
  | Password* | Enter your password | Yes | non-empty; show/hide toggle (eye icon, aria-pressed) | •••••••• |
- **Primary CTA:** "Sign in". **Secondary:** show/hide password; "Forgot password?".
- **States:** *Loading:* button shows spinner + "Signing in…", fields disabled. *Success:* redirect to `next` or Dashboard. *Empty:* n/a. *Error – invalid credentials:* banner above form "Incorrect email or password." (never reveals which; password field cleared, email retained, focus on password). *Error – rate-limited:* "Too many attempts. Try again in a few minutes." *Network failure:* "Can't reach the server. Check your connection and try again." Retry via same button.
- **Edge cases:** already logged in → redirect to Dashboard; Enter key submits; password managers supported (autocomplete attributes); session expiry returns here with notice "Your session expired. Please sign in again." and preserves `next`.
- **Session handling:** session lasts per Stage 1 expiry; activity extends it. 2 minutes before expiry nothing intrusive; on expiry, mid-task a modal (S12) lets the user re-enter the password without losing the screen's unsaved form data; import review state is server-persisted.
- **Mobile:** card full-width with 16px gutters; keyboard-safe layout (CTA stays above keyboard). **Desktop:** centered card. **After completion:** Dashboard (or `next`).

### S2 — Dashboard
- **Purpose:** answer "How much money do I need to collect?" **Entry:** login, nav, logo.
- **Layout:** page title "Dashboard". Row of 4 metric cards, then "Recent collections" table/list (10), then (if any) an "Action needed" strip.
- **Metric cards (Stage 1 five metrics):**
  | Card | Meaning |
  |---|---|
  | **Total outstanding** (hero, largest) | Σ outstanding of non-cancelled collections |
  | **Total collected** | Σ VERIFIED payments |
  | **Pending** | outstanding on collections not yet due (or no due date), not cancelled; count under amount |
  | **Overdue** | outstanding where due date passed; count; red accent + icon |
  Each card shows amount + "N collections". Cards link to Collections pre-filtered (Outstanding→all open, Pending→status filter, Overdue→overdue filter, Collected→Paid filter).
- **Recent collections:** columns Customer · Amount due · Outstanding · Due date · Status; row → detail; "View all" link.
- **Action-needed strip (only items derived from existing data, no new feature):** "N collections have no phone number" and "N imports waiting for review" (link to the batch). Hidden when zero.
- **Primary CTA:** "Upload collection file" (top right; sticky FAB-style bar on mobile). **Secondary:** metric-card links.
- **States:** *Loading:* skeleton cards + 5 skeleton rows. *Error:* inline card "Couldn't load your dashboard." + Retry (nothing else blocked; nav works). *Network failure:* offline banner. *Success:* n/a.
- **Variants:**
  1. **New employer (empty):** metric cards show ₹0.00; instead of table, an empty-state panel: icon, "No collections yet", text "Upload a spreadsheet, CSV, Word or PDF file with the amounts you need to collect. You'll review everything before it's imported.", CTA "Upload your first file". Plus one-line setup hint "Add your payment details in Settings so customers know how to pay" (link) if settings not yet filled.
  2. **After first import:** Total outstanding = imported sum; Collected ₹0.00; Pending = outstanding; list shows imported rows with status PENDING; strip shows "N collections have no phone number" if applicable.
  3. **After payments exist:** Collected > 0; list shows mix of PAID / partially paid / overdue badges; Overdue card active.
- **Edge cases:** large numbers use compact display only if > ₹99,99,99,999 (never in V1 expected); cancelled collections excluded from totals with a footnote "Cancelled collections are not included."
- **Mobile:** cards in 2×2 grid (hero full width on top); recent list as cards. **Desktop:** 4 cards in one row; table. **After completion:** n/a.

### S3 — Upload
- **Purpose:** start an import. **Entry:** nav, dashboard CTA, empty states.
- **Layout:** title "Upload collection file". Explainer box (info alert): *"We'll read your file and suggest customer names, amounts and other details. **You'll review everything before anything is imported — nothing is sent to customers automatically.**"* Drop zone (dashed, large) with icon, "Drag a file here or **Choose file**", supported-types line: "Excel (.xlsx, .xls), CSV, Word (.docx) or PDF · up to 10 MB". Below: tip text "Using Google Sheets? Download it as Excel or CSV (File → Download), then upload it here." Then **Recent imports** list: filename, uploaded date, status (Waiting for review / Imported / Failed / Discarded), row counts, action (Resume review / View).
- **Field:** File* — single file (one per upload). Validation (client-fast, server-authoritative): extension in list; size ≤ 10 MB; not empty (0 bytes); one file only. Example: `October_Collections.xlsx`.
- **Primary CTA:** "Upload and continue" (enabled once a valid file is selected; selecting a file shows a file chip with name, size, type icon, remove ✕). **Secondary:** Choose file; Remove; Resume review (recent imports).
- **States:**
  - *Drag-over:* border solid accent, text "Drop to upload".
  - *Loading/progress:* chip shows progress bar + % + "Uploading…"; Cancel link aborts. Upload and Choose are disabled meanwhile.
  - *Duplicate file detected (exact hash match):* amber panel after upload: "This exact file was already imported on 12 Oct 2026 (118 collections)." Actions: **Cancel upload** (default, primary), **Upload anyway** (secondary). Matches Stage 1 P.1.
  - *Invalid type:* red inline alert: "We couldn't process this file. Supported formats are Excel, CSV, PDF and Word." (exact copy); chip not created.
  - *Too large:* "This file is 14.2 MB. The limit is 10 MB. Try splitting it into smaller files."
  - *Empty file:* "This file is empty."
  - *Password-protected/corrupt (detected server-side after upload):* batch shown as Failed on S4 (see there).
  - *Network failure during upload:* "Upload interrupted. Check your connection and try again." with Retry (re-sends the same file).
  - *Success:* auto-navigate to S4.
  - *Empty (recent imports):* "No imports yet."
- **Edge cases:** multiple files dropped → "Please upload one file at a time." ; macro files (.xlsm/.docm) → treated as unsupported type; file renamed with wrong extension → server rejects with unsupported-file message; double-click on CTA is ignored while uploading; leaving page during upload prompts "Upload in progress. Leave anyway?".
- **Mobile:** drop zone becomes a large "Choose file" button area (drag n/a); recent imports as cards. **Desktop:** drop zone + list. **After completion:** S4.

### S4 — Processing
- **Purpose:** show progress while the system reads the file; no technical detail. **Entry:** after upload; also from Recent imports when status is Processing.
- **Layout:** step indicator (Upload ✓ → **Processing** → Review → Confirm) and a centered card with the filename, and a vertical checklist:
  1. Uploading ✓
  2. Reading file
  3. Identifying columns and content
  4. Extracting records
  5. Checking records
  6. Preparing your review
  Active step shows spinner; completed steps checkmark; text beneath: "This usually takes under a minute. You can leave this page — we'll keep your progress under **Recent imports**." Optional "Back to Upload" link.
  For scanned PDFs the checklist step 3 reads "Reading scanned pages (this takes longer)" and shows an info note: "This looks like a scanned document. We'll read the text automatically, and **you'll need to check every extracted record**."
- **Success states:** (a) column structure clear → auto-advance to S6 Review; (b) structure uncertain → auto-advance to S5 Mapping; announced via live region "Your file is ready for review."
- **Failure states (card replaces checklist; icon + plain message; batch status FAILED; no records created):**
  | Case | Message | Actions |
  |---|---|---|
  | Unsupported file | "We couldn't process this file. Supported formats are Excel, CSV, PDF and Word." | Upload a different file |
  | Corrupted / unreadable | "This file seems damaged or unreadable. Try re-saving it and uploading again." | Upload a different file |
  | Password-protected | "This file is password-protected. Remove the password and upload it again." | Upload a different file |
  | No records found | "We couldn't find any collection details in this file. Check that it has customer names and amounts." | Upload a different file; Discard |
  | Scanned PDF could not be read | "We couldn't read this scanned file clearly. Try a clearer scan or upload an Excel/CSV version." | Upload a different file |
  | Temporary failure (timeout/server) | "Something went wrong while reading your file. Your existing collections are not affected." | **Try again** (reprocess same file, primary), Upload a different file |
  | Network lost while waiting | Banner "Connection lost — still processing. Reconnecting…"; polling resumes automatically |
- **Edge:** processing > 2 minutes → reassurance text "Large files can take longer."; user can leave and resume; browser refresh keeps state (batch id in URL).
- **Mobile/Desktop:** single centered card; identical. **After completion:** S5 or S6.

### S5 — Column Mapping (interpretation review)
- **Purpose:** let the employer confirm what the system interpreted when it is unsure. **Shown when** column confidence is low/ambiguous, or required fields missing. Always reachable from S6 via "Review column mapping".
- **Layout:** title "Check how we read your file". Intro: "We found these columns. Confirm what each one means. Nothing is imported yet." Two-part layout:
  1. **Mapping list** — one row per **canonical field** (Customer name*, Amount due*, Phone, Email, Due date, Reference, Description). Each row: field label, a **dropdown** of the file's columns (+ "— Not in this file —"), a confidence chip (High / Medium / Low with text, not color alone), and a sample value from the first non-empty row ("e.g. Ramesh Traders").
  2. **Preview table** — first 5 rows of the file as interpreted under the current mapping, with mapped headers highlighted; updates live as dropdowns change.
  Below mapping: **Unmapped columns** collapsible list ("These columns will be ignored: Remarks, Salesman, Region") each with a sample value; each can be assigned to Description via the dropdown above (no free-form extras).
- **Fields (dropdowns):** Required: Customer name, Amount due. Optional: others. Validation: Customer name and Amount due must each be mapped; one file column cannot map to two fields (selecting an in-use column swaps with a warning chip "Moved from Reference"). Example: Amount due ← "Outstanding".
- **Alternative mappings:** dropdown lists all columns sorted with the system's top alternatives first, labeled "Suggested".
- **Primary CTA:** "Confirm mapping and continue" (disabled until required fields mapped). **Secondary:** "Reset to suggested", "Upload a different file", Back.
- **States:** *Loading (re-processing after confirm):* "Applying your mapping…" overlay with spinner; *Error:* inline "We couldn't apply this mapping. Try again." (mapping kept); *Required field missing:* red message "Choose which column holds the customer name."; *Success:* → S6. *Low-confidence banner:* amber "We weren't sure about some columns. Please check the highlighted rows." *Empty preview:* "No rows to preview — check the mapping or file."
- **Edge cases:** multiple sheets → a **Sheet** selector at top ("Sheet: October ▼") that re-runs interpretation; header row not first → "Header row: Row 3 ▼"; PDF/Word text-extracted data has no columns → S5 is skipped; the user goes straight to S6 with "Extracted from text — review carefully" notice.
- **Mobile:** each field is a stacked card (label, dropdown, confidence, sample); preview becomes a horizontally scrollable 5-row table inside a card (the only horizontal scroller allowed, with visible scroll hint). **Desktop:** mapping list left, preview right (sticky). **After completion:** S6.

### S6 — Import Review (most important screen)
- **Purpose:** verify extracted records, fix problems, accept/reject, then proceed. **Entry:** S4/S5, Recent imports → Resume.
- **Layout (desktop):**
  1. Step bar (Upload ✓ · Processing ✓ · **Review** · Confirm).
  2. **Summary bar:** "**127** records detected · **119** ready · **8** need review" + secondary chips: errors N · warnings N · duplicates N · OCR N. File name, "View column mapping" link, source note (e.g., "Excel · Sheet: October").
  3. **Toolbar:** search ("Search customer, phone, reference"), filter chips (All · Ready · Needs review · Errors · Warnings · Duplicates · OCR · Rejected), row count, "Accept all ready rows" (see rules).
  4. **Table:** checkbox? — none (to avoid bulk accidents). Columns: **#** · **Customer** · **Amount** · **Phone** · **Email** · **Due date** · **Reference** · **Status** (validation badge + issue count) · **Source** (Table / Text / AI / **OCR**) · **Decision** (Accepted / Rejected / Pending segmented) · **⋯** (Edit).
  5. **Sticky footer bar:** left "N accepted · N rejected · N pending", right primary "Continue to confirmation" (enabled only when no blockers; see below).
- **Row validation states** (icon + text label, never color alone):
  | Level | Badge | Examples | Behavior |
  |---|---|---|---|
  | **Error (hard)** | red "Error" + ✕ | Missing customer; missing amount; invalid amount; amount ≤ 0 | Row cannot be accepted until fixed; may be rejected. Accept control disabled with tooltip "Fix errors first." |
  | **Warning** | amber "Warning" + ! | Invalid/missing phone; invalid/ambiguous date; missing reference; possible duplicate; suspicious amount (>10× median); low-confidence OCR/AI | Can be accepted; accepting a warning row shows a single inline acknowledge ("Accept with warning") — one tap, no modal. |
  | **Info** | grey "Note" + i | "Amount cleaned: 'Rs 1,200' → ₹1,200.00"; "Phone reformatted to +91 98xxxxxx"; "Matched existing customer" | Informational only; shown in the row detail. |
  | **Ready** | green "Ready" ✓ | No issues | Default decision Pending → "Accept all ready rows" accepts these only. |
  Invalid cells are outlined and carry an inline message in the edit drawer; in the table the problem cell shows an icon with tooltip/long-press text.
- **Row decision control:** segmented **Accept / Reject** (default: Pending for everything; Ready rows become Accepted via "Accept all ready rows"). Rejected rows are greyed with strikethrough customer, reversible.
- **"Accept all ready rows":** accepts rows with *no errors, no warnings, not OCR, not duplicate*. Confirmation toast "112 ready rows accepted" with Undo (10s). It never touches OCR, duplicate, warning, or error rows. There is **no** "accept all" for any other category.
- **Edit (row drawer; desktop side panel 420px, mobile full-screen sheet):** fields:
  | Label | Placeholder | Req | Validation | Example |
  |---|---|---|---|---|
  | Customer name* | Customer or company name | Yes | non-empty, ≤120 chars | Sharma Traders |
  | Amount due* | 0.00 | Yes | numeric >0, ≤2 decimals, ≤ ₹99,99,99,999.99; accepts "1,200" and "₹1200" and normalizes | ₹12,500.00 |
  | Phone | 98765 43210 | No | normalizes to +91 E.164; 10 digits starting 6–9 (else warning) | +91 98765 43210 |
  | Email | name@example.com | No | email format | accounts@sharma.in |
  | Due date | DD/MM/YYYY | No | valid date; shows ambiguous-date resolver ("Did you mean 03 Apr or 04 Mar?") | 15/10/2026 |
  | Reference | Invoice or reference no. | No | ≤60 chars | INV-2041 |
  | Description | Notes | No | ≤250 chars | October supplies |
  Drawer shows: **Original value from file** (read-only grey text under each edited field), issues list with plain-language fixes, source badge, and for OCR/AI rows a **source snippet** (page/line text) if available. Buttons: **Save** (primary; revalidates instantly), **Save and accept**, **Reject row**, **Cancel**; Prev/Next row arrows to review sequentially (keyboard: ↑/↓ or J/K).
- **States:** *Loading:* skeleton summary + 10 skeleton rows. *Empty (zero records):* "No usable records found" + Upload another file + Discard. *Empty filter result:* "No rows match this filter." + Clear filters. *Error:* "Couldn't load records." + Retry. *Save error:* inline banner inside drawer, edits kept. *Success:* toast "Row saved" and row status updates; summary counts update live. *Session expiry mid-review:* S12 modal; edits already saved remain (server-side persisted).
- **Large dataset behavior:** up to ~2,000 rows: server-paginated/virtualized, 50 rows per page on desktop with page controls; search/filters server-side; counts in summary always reflect the whole batch. Default sort: problem rows first (errors → OCR/pending → warnings → duplicates → ready), then file order; user can sort by #, Customer, Amount, Due date.
- **Blockers for "Continue to confirmation":** (1) any row with hard error that is not rejected; (2) any OCR row not explicitly Accepted or Rejected; (3) any duplicate row with no chosen action. Clicking the disabled button is allowed and opens the **Blockers panel** listing counts with "Show these rows" links (filters table). Never fails silently.
- **Primary CTA:** "Continue to confirmation". **Secondary:** Edit row, Accept/Reject, filters, "Discard this import" (destructive confirm: "Discard import? Nothing has been added to your collections. You can upload the file again.").
- **Mobile behavior:** summary becomes a collapsible header; table → **row cards**: line 1 customer + amount (bold), line 2 phone · due date · reference, line 3 validation badge + source badge, bottom: Accept / Reject buttons (44px) and "Edit". Filters in a horizontal chip scroller + "Filter" bottom sheet; search in header. Sticky bottom bar with counts + Continue. **Desktop:** full table with sticky header and sticky footer bar; drawer on right.
- **After completion:** S7.

### S6 (OCR) — see §10 for OCR-specific UX; S6a (duplicates) — see §11.

### S7 — Import Confirmation
- **Purpose:** final summary and explicit confirm before collections are created. **Entry:** S6.
- **Layout:** title "Confirm import". Summary card:
  | Line | Example |
  |---|---|
  | Total rows in file | 127 |
  | Ready (no issues) | 104 |
  | Accepted with warnings | 11 |
  | OCR rows accepted after review | 0 |
  | Duplicates: imported anyway | 2 |
  | Duplicates: skipped | 4 |
  | Rejected by you | 3 |
  | Rows with errors skipped | 3 |
  | **Collections that will be created** | **117** |
  | **Total amount** | **₹14,82,350.00** |
  Each line is a link back to S6 with the matching filter. Beneath: a plain-language box "**What happens next:** 117 collections will be added with status *Pending*. New customers will be created for names not already in your list. **No messages or payment requests are sent.** You can send requests from each collection."
- **Fields:** none required. (A checkbox is *not* used; the button label itself carries the commitment.)
- **Primary CTA:** **"Create 117 collections"** (label contains the exact count; amount repeated in subtext "₹14,82,350.00"). **Secondary:** "Back to review", "Discard import".
- **States:** *Loading:* button spinner "Creating collections…", page locked (everything is one transaction). *Success:* success screen with check icon "117 collections created", mini stats, CTAs "View collections" (primary → S8 filtered to this import) and "Upload another file". *Error:* red alert "Import failed. Nothing was added — your collections are unchanged." + **Try again** (idempotent); batch remains in review. *Already imported (double-click/other tab):* "This import was already completed." + View collections. *Nothing to import (0 rows):* CTA disabled, message "No rows are accepted. Go back to review."
- **Edge:** if row state changed since S6 (e.g., session in another tab), server revalidates and shows "N rows changed — please review again."
- **Mobile:** summary as stacked list; sticky bottom primary button. **Desktop:** two-column (summary left, "What happens next" right). **After completion:** S8.

### S8 — Collections List
- **Purpose:** find and manage collections. **Entry:** nav, dashboard links, import success.
- **Layout:** title "Collections" + count; toolbar: search ("Search customer, reference, phone"), **Status filter** (All · Pending · Sent · Paid · Cancelled), **Indicator filters** (Overdue · Partially paid · No phone), **Request filter** (None · Active · Out of date · Balance changed · Revoked), **Due date** range (Any · Overdue · Next 7 days · This month · custom), sort menu (Due date ↑/↓, Amount ↓, Created ↓, Customer A–Z). Active filters shown as removable chips + "Clear all".
- **Table columns:** Customer (name + phone grey below) · Reference · Amount due · Outstanding · Due date · Status (badge + derived indicators) · Request (None / Active / Out of date / Balance changed / Revoked; both amber/blue tags can show together) · Created. Row click → S9. Row ⋯ menu: View, Copy link (only if an ACTIVE request exists; fetches the link on demand — the list response never contains links; failure toast "Couldn't get the link. Try again.") — nothing destructive in list.
- **Status display:** stored status badge (Pending / Sent / Paid / Cancelled) + derived badges "Overdue" (red outline, shown when due date passed and outstanding > 0) and "Partially paid" (blue outline, shows "₹4,000 paid"). Both can appear together. No other statuses.
- **Primary CTA:** "Upload file" (page header). **Secondary:** filters, sort.
- **States:** *Loading:* skeleton rows. *Empty (no collections):* "No collections yet" + Upload CTA. *No search results:* "No collections match 'sharma'." + Clear search/filters. *Error:* "Couldn't load collections." + Retry. *Network failure:* offline banner, cached rows stay with "Showing last loaded data" label.
- **Large datasets:** server-side search/filter/sort; paginated 50/page (desktop page controls with total; mobile "Load more" button, not infinite scroll); filter and sort state in URL so back-button works; totals row at bottom of filtered view: "Showing 38 collections · Outstanding ₹4,20,000.00".
- **Edge:** collections with no phone show "No phone" chip; cancelled rows greyed; very long names truncate with tooltip.
- **Mobile:** cards (customer + status badge top; amount due & outstanding middle; due date and request state bottom); search pinned; "Filters" button opens bottom sheet with all filters + Apply; active filter count on button. **Desktop:** table with sticky header, filters inline. **After completion:** n/a (row → S9).

### S9 — Collection Detail
- **Purpose:** the single place for every per-collection action. **Entry:** list, dashboard, import success.
- **Layout (desktop):** breadcrumb "Collections › Sharma Traders". Header: customer name, status badge + derived badges, reference. Two columns:
  - **Left (main):** tabs **Overview · Payments · Payment request · History** (Overview content is always visible above tabs? — decision: Overview card always shown; tabs below for Payments, Payment request, History).
  - **Right (sticky summary card):** Amount due · Verified payments · **Outstanding** (largest) · Due date (with "Overdue by 12 days" if applicable) · primary actions.
- **Overview card:** Customer (name, phone, email – "Add phone" link if missing), Reference, Description, Source (e.g., "Imported from October_Collections.xlsx on 12 Oct 2026"), Created.
- **Money block:** `Amount due ₹10,000.00 − Verified payments ₹4,000.00 = Outstanding ₹6,000.00` (always displayed as this equation).
- **Payments tab:** table: Date · Amount · Method · UTR/Reference · Status (Verified / Void) · Recorded by · action "Void" (only Verified). Totals footer. Empty: "No payments recorded yet." with Record Payment CTA. Void rows are greyed with reason tooltip and remain listed.
- **Payment request tab (section):** card with request status chip (**None · Active · Revoked**) plus up to two employer-side notices when the request is Active: **Out of date** (customer-facing info changed) and/or **Balance changed** (requested amount ≠ current outstanding) — see §16; created date, **"Requested amount ₹10,000.00"**, snapshot details expandable ("What the customer sees": name, requested amount, reference, employer display name, enabled methods with details, QR thumbnail), first/last viewed ("Opened 2 times · last 14 Oct 2026, 4:12 PM" — information only, with note "Opening the link does not mean payment was made"), and actions.
- **Actions (visibility by state):**
  | Action | Where | When shown | Style |
  |---|---|---|---|
  | **Generate request** | request section / summary card | status not PAID/CANCELLED and no active request | primary |
  | **Send via WhatsApp / SMS / Copy link** | request section | ACTIVE request exists (works any time after creation, not only right after) — each action fetches the existing link on demand via the secure "get link" action; no new request is created | primary (WhatsApp), secondary others |
  | **Regenerate request** (label becomes **"Regenerate for ₹6,000"** when only the balance changed) | request section | active request exists (always) – emphasized when Out of date or Balance changed | secondary; primary when either notice shows |
  | **Revoke request** | request section | active request | destructive-outline |
  | **Record Payment** | summary card | outstanding > 0 and not CANCELLED | primary (if no active request) / secondary |
  | **Void** | payments row | Verified payments | destructive link |
  | **Edit** | overview card | not CANCELLED | secondary |
  | **Cancel collection** | ⋯ menu only | not CANCELLED | destructive; kept out of the primary action area |
  | **Reopen collection** | summary card | CANCELLED | secondary |
  Disabled actions show a tooltip/inline reason ("Add a phone number to send via WhatsApp").
- **Edit rules (S9a modal "Edit collection"):** Fields: Customer name*, Phone, Email, Due date, Reference, Description, **Amount due*** (same validation as S6 drawer; amount ≥ verified payments total). If an active request exists, an amber alert in the modal: "A payment request has already been created. Your changes **won't** change it. After saving you can regenerate the request." Save button wording by what changed: customer name/reference → "Save changes (request will be out of date)"; amount due → "Save changes (request balance will change)"; both → "Save changes (request will be out of date and balance changed)". Success toast + the matching notice(s) appear (§16). Errors inline. Cancelled collections are read-only.
- **States:** *Loading:* skeleton header/summary. *Error:* "Couldn't load this collection." + Retry/Back. *404:* "Collection not found." + Back to Collections. *Success toasts* per action. *Collection PAID:* money block shows Outstanding ₹0.00, green "Paid" badge, Record Payment hidden, request actions limited to "Revoke" (if still active—note: page shows Paid to customer) and Copy not shown; History visible. *CANCELLED:* red banner "This collection is cancelled. Payment requests have been revoked." with Reopen.
- **Link retrieval states (Copy / WhatsApp / SMS on an existing active request):** *Loading:* button spinner "Getting link…" (<1s). *Success:* copy toast / opens preview sheet. *Error:* "Couldn't get the link. Try again." with Retry; if it persists, hint "You can regenerate the request to get a new link." *Revoked/none:* actions hidden (link not retrievable). The link text itself is never printed on the page except in the creation-success step and the Copy-confirmation (masked after 10s).
- **Edge cases:** no phone → WhatsApp/SMS buttons disabled with tooltip, Copy link still available; payment settings empty → Generate request blocked with alert "Add at least one payment method in Settings first" linking to S10; overdue shows "Overdue by N days".
- **Mobile:** single column: header, **sticky summary strip** (Outstanding + primary action button), then accordion sections (Details, Payments, Payment request, History); modals become full-screen sheets; destructive actions in a "More" bottom sheet. **Desktop:** two-column with sticky right card. **After completion:** stays on S9 with updated data.

### S9 — Out-of-date banner (see §16) — shown at the top of the request section and as a thin banner under the header.

### S9b — Generate / Regenerate Payment Request (see §15)
### S9c — Send request (see §17)
### S9d — Revoke request
- Modal "Revoke payment request?": body "The current link will stop working. Customers who open it will see that the request is no longer active. This cannot be undone, but you can generate a new request." Shows request created date & requested amount. If the collection is already PAID, add: "The customer will see 'This payment request is no longer active' instead of 'Payment received'." Revoking also **permanently removes the ability to copy this link again**. Buttons: **Revoke request** (destructive), Cancel. Success toast "Request revoked." Section returns to "No active request" with Generate CTA. Error inline with retry. Audited.
### S9e — Record Payment (see §20) · S9f — Void Payment (see §22)
### S9g — Cancel / Reopen collection
- **Cancel:** modal "Cancel this collection?": "Cancelling marks the collection as Cancelled and **revokes its active payment request**. Recorded payments are kept. You can reopen it later." Impact list: Outstanding stays ₹X (excluded from dashboard totals); active request revoked: Yes/No. Optional text field "Reason (optional)" ≤200 chars. Buttons: **Cancel collection** (destructive), "Keep collection". Success toast; banner shown.
- **Reopen:** modal "Reopen this collection?": "It will return to Pending/Sent based on its history. Revoked requests stay revoked — generate a new one if needed." Buttons Reopen / Cancel.

### S10 — Payment Settings (see §19)
### S11 — Customer Payment Page (see §18)

### S12 — Global screens
- **Session-expired modal** (see §24). **Employer 404:** "Page not found" + "Go to Dashboard". **Offline banner:** top, amber: "You're offline. Changes can't be saved until you reconnect."; disappears on reconnect with toast "Back online."

---

## 5. (Authentication) — covered in S1; no registration, roles, SSO or social login.

## 6–7. Dashboard / Upload / Processing — covered in S2–S4.

## 8. Column mapping — S5.

## 9. Import review — S6 (above).

## 10. OCR-SPECIFIC UX
- **Detection signals shown:** on S4 (info note), on S6 summary (purple "Scanned document (OCR)" banner), per row (badge).
- **Banner on S6 (persistent, cannot be dismissed):** icon + "**This file was read from a scanned document using text recognition.** Values may be misread. You must check and accept every record individually before importing." + count "42 of 42 OCR records still need your review."
- **OCR badge:** purple pill "OCR" with scan icon in Source column; accessible name "Read by text recognition".
- **Confidence indicator:** per row a 3-level label with icon & text: **Clear** (✓), **Check** (!), **Unclear** (?) — numeric % in tooltip/drawer only. Low-confidence **cells** are underlined with a dotted warning outline.
- **Row review:** OCR rows default **Not reviewed** (neutral); the Decision control for OCR rows is **Accept / Reject** with no pre-selection and **no keyboard "select all"**. The edit drawer shows the **source image crop/snippet** of that row beside the editable fields (when available; else the extracted text) so the employer compares original vs. read value. "Save and accept" is the intended path; accept requires the drawer or row to have been opened at least once? — **No** (avoids a hidden rule); instead acceptance is an explicit per-row tap.
- **No bulk accept:** "Accept all ready rows" excludes OCR rows; no checkboxes, no multi-select, no "accept page" shortcut. The summary text explicitly says "OCR records must be accepted one by one."
- **Progress affordance:** "OCR review: 12 / 42 reviewed" progress bar in sticky footer; "Next unreviewed OCR row" button jumps to the next.
- **Confirming without review:** "Continue to confirmation" is disabled while any OCR row is Not reviewed; clicking it opens the Blockers panel: "**30 scanned records haven't been reviewed.** Accept or reject each one before continuing." with "Review next record" CTA. Server enforces the same rule; if a race occurs on S7, error "Some scanned records still need review." → returns to S6 filtered to OCR.
- **Rejected OCR rows** are fine (count as reviewed). If the file is entirely unreadable → S4 failure state.

## 11. DUPLICATE HANDLING
- **Where flagged:** S6 row warning "Possible duplicate" with sub-label "Matches an existing collection" or "Same as row 14 in this file". Filter chip **Duplicates**. Per-row Decision control for duplicates is replaced by a **three-option control: Skip · Import Anyway · Review Existing**; default **Skip** (preselected, shown as chosen so the safe default is visible); changing it is a deliberate action. There is no "Update Existing" anywhere.
- **Actions:**
  - **Skip** — row excluded from import (counted as "Duplicates skipped").
  - **Import Anyway** — row will create a new collection; small label "Imported as duplicate"; audited.
  - **Review Existing** — opens comparison panel S6a; it does not change anything by itself.
- **S6a comparison panel (desktop: right panel/modal 2 columns; mobile: full-screen sheet with stacked "Existing" then "Incoming" cards and a diff list):**
  - **Against existing collection:** left "**Existing collection**" (customer, amount due, outstanding, due date, reference, status, created/import source, payments count) with link "Open collection in new tab"; right "**Incoming row**" (same fields). Field rows where values differ are highlighted with "Changed" tag and both values shown; matching fields show "Same". Header explains the match basis: "Matched on customer + reference INV-2041".
  - **Within the same file:** left "**Row 14 in this file**", right "**Row 87 in this file**"; same highlighting. Header: "These two rows look the same."
  - Footer buttons: **Skip incoming row** (default/primary), **Import Anyway** (secondary), **Close**. Note: "To correct the existing collection, edit it from its page after import. We won't change it automatically."
  - If amount/date differ: info note "Looks like a corrected version of an existing record. You can skip this row and edit the existing collection yourself."
- **Duplicate file (whole file)** handled at S3 (exact-hash warning).
- **Edge:** one incoming row matching several existing collections → panel shows a selector "Match 1 of 3"; two duplicate pairs in-file: acting on one row does not affect the other; Import Anyway on both rows of an in-file pair is allowed and flagged on S7 ("2 duplicates imported anyway").
- **Blocker:** duplicates with no explicit action cannot occur because Skip is the default; the blocker list therefore only covers errors and OCR.

## 12. Import confirmation — S7.

## 13. Collections list — S8. · 14. Collection detail — S9.

## 15. PAYMENT REQUEST CREATION (S9b)
- **Entry:** "Generate request" or "Regenerate request" on S9.
- **Layout:** modal (desktop 640px) / full-screen sheet (mobile) titled "Create payment request" (or "Regenerate payment request"). Two parts:
  1. **Preview — "This is exactly what your customer will see"**: a framed mini-replica of S11 (read-only) with the snapshot values: employer display name, customer name, requested amount (default = **current outstanding**, shown but not editable), reference, enabled methods (UPI ID, UPI number, QR, bank details). Methods disabled in Settings are absent.
  2. **Snapshot notice (info alert):** "**This request is a snapshot.** If you later change the customer, amount, reference or your payment details, this link will **not** change. To update what the customer sees, regenerate the request."
  Regenerate adds a warning: "The current request (₹10,000.00, created 12 Oct 2026) will be **revoked**. Its link will stop working immediately and can't be copied again." and a diff list "What's different from the current request" grouped under the two concepts — **Balance changed** (Requested amount ₹10,000.00 → ₹6,000.00) and **Out of date** (UPI ID changed; Reference changed). Modal title/CTA when only the balance changed: "Regenerate for ₹6,000.00".
- **Fields:** none editable here (requested amount = outstanding; edit collection first if wrong). Explicit confirmation control: checkbox **"I've checked these details"** (required) enabling the primary CTA. (Keeps accidental taps from creating requests.)
- **Primary CTA:** "Create request" / "Regenerate and revoke old request". **Secondary:** Cancel; "Edit collection" link; "Payment settings" link.
- **States:** *Loading preview:* skeleton. *Blocked:* no payment method enabled → alert "Add at least one payment method in Settings before creating a request." CTA disabled + link. Outstanding ₹0 or collection cancelled/paid → modal not available. *Submitting:* spinner. *Success:* modal switches to success step: "Request created" with link field (read-only, copy icon) and buttons **Send via WhatsApp**, **Send via SMS**, **Copy link**, "Done". *Error:* "Couldn't create the request. Nothing was changed." + Retry. *Race (settings or collection changed while modal open):* "Details changed. Please review the updated preview." → preview refreshes, checkbox resets.
- **Edge:** the link appears in the page on creation success and is otherwise retrieved **on demand** by Copy link / WhatsApp / SMS on the active request (secure "get link", no new request); regenerate always yields a new link. Only one active request per collection is enforced — UI offers only Regenerate when one exists (no second "Generate").
- **Mobile:** sheet with preview scrollable and sticky footer (checkbox + CTA). **After completion:** success step → S9.

## 16. REQUEST NOTICES: "OUT OF DATE" vs "BALANCE CHANGED" (two separate concepts)
Both apply only to an **ACTIVE** request. Neither changes the request or the customer's link; nothing is revoked or regenerated automatically. They can show together.

**A. Out of date** (amber) — *customer-facing information* differs from the snapshot: customer name, reference, employer display name, or payment details (UPI ID, UPI number, QR, bank details, enabled methods).
- **On S9:** amber banner under header: "**This payment request is out of date.** Your customer's link still shows the original details." Request section tag **Out of date** and a **"What's different"** table: Item · Customer sees now · Current value (e.g., Reference INV-2041 → INV-2041-A; UPI ID acme@okaxis → acme@oksbi; Customer name changed). Also existing request status (Active, created date, last viewed). CTA **Regenerate request** (primary) with note "This will revoke the current link and create a new one." Alternatives: "Keep current request" (hides banner for this session; tag stays) and Revoke.

**B. Balance changed** (blue/info) — the **requested amount** differs from the current **outstanding** (partial payment recorded, payment voided, or collection amount edited).
- **On S9:** info banner: "**Balance changed.** The existing payment request still asks for ₹10,000.00. You can regenerate a new request for the remaining ₹6,000.00." with mini equation *Requested ₹10,000.00 · Received ₹4,000.00 · Remaining ₹6,000.00*. Primary CTA **"Regenerate for ₹6,000.00"**; secondary "Keep current request". If a void raises outstanding above the request, same banner with the new numbers ("…regenerate for ₹10,000.00"). If outstanding is ₹0 (PAID) the notice is not shown and no regenerate CTA exists.
- **If both apply:** two stacked notices share one CTA **"Regenerate request"**; the regenerate modal shows both groups in its diff (§15).

- **In S8 list:** Request column shows **Out of date** (amber) and/or **Balance changed** (blue) tags; both are filterable (Request filter).
- The snapshot model is unchanged: the customer keeps seeing the original requested amount and details until the employer regenerates/revokes.
- **Settings-driven (see §19):** after saving payment details, S10 shows an **outdated-requests panel**: "**14 active payment requests still use your previous payment details.**" Buttons: "Review requests" (opens S8 filtered `Request: Out of date`, with a "Regenerate…" multi-step) and "Dismiss for now". The list view for this filter allows opening each collection to regenerate individually (no bulk regenerate in V1; no new feature). The count stays visible on S10 and as a dot on the Settings nav item until zero.

## 17. PAYMENT REQUEST ACTIONS (S9c) — manual sending only
- **WhatsApp:** button "Send via WhatsApp" → opens **message preview sheet** first: recipient (name + +91 98765 43210, with "Wrong number? Edit phone" link), editable message text? — **No; message text is a fixed template** (no custom message feature): "Hello {customer name}, {employer display name} has sent you a payment request of ₹10,000.00 (Ref: INV-2041). Please view the payment details here: {link}". Buttons: **Open WhatsApp** (primary; opens `wa.me` deep link in new tab/app), Cancel. After the user returns, a prompt: "Did you send the message?" **Yes, mark as sent** / **No, not yet**. Yes → logs a notification (MANUAL) and moves PENDING → SENT. (Stage 1: SENT = first successful send/link marked shared.) No → nothing changes.
- **SMS:** same flow with SMS preview (shorter text) and **Open SMS app** (`sms:` link); same "Did you send it?" prompt. Desktop without SMS handler: fallback message "SMS isn't available on this device. Copy the message instead." + "Copy message".
- **Link source (all three actions):** on an existing ACTIVE request the link is fetched **on demand** through the secure "get link" action (see Stage 1 adjustment) — not stored in page data. The same link is returned every time; no second request is created. Immediately after creation it is available directly from the success step.
- **Copy link:** copies the secure URL; toast "Link copied". Prompt after copy (once per request): "Did you share it with the customer?" Yes → mark SENT.
- **Disabled states:** no phone → WhatsApp/SMS disabled (tooltip "Add a phone number"; link "Add phone" opens Edit). Request revoked/none → buttons hidden; collection PAID/CANCELLED → hidden.
- **Repeat send:** allowed; each logged in History ("Request sent via WhatsApp"). No bulk sending anywhere. No provider settings.
- **Error:** invalid phone format → inline "This phone number looks invalid." blocks Open WhatsApp until fixed. Clipboard failure → show the link in a selectable field.
- **Mobile:** deep links open apps directly; **desktop:** WhatsApp Web/Desktop via browser.

## 18. CUSTOMER PAYMENT PAGE (S11) — public, `/pay/<token>`
- **Purpose:** show the snapshotted payment instructions. **Access:** anyone with link. **Layout:** single narrow column (max 480px), standalone, no nav, `noindex`.
- **Active request layout (top to bottom):**
  1. **Employer display name** (header with simple initial-avatar) + small text "Payment request".
  2. **Amount card:** "Amount requested" **₹10,000.00** (largest); customer name "For: Ramesh Traders"; "Reference: INV-2041" (if any).
  3. **"How to pay" section** — only enabled methods, each in its own card:
     - **UPI** — UPI ID (monospace) with **Copy** button; "Pay with UPI app" link (`upi://pay?...pa=…&am=…` pre-filled amount? **No** — to honor "no live/dynamic amount" and avoid implying capture, include pa & pn & snapshot amount; amount equals the snapshot) — button label "Open UPI app". Small text under it: "Opening your UPI app does not complete payment. Please confirm the amount and payee before paying."
     - **UPI number** — number with Copy.
     - **QR code** — large (≥240px) with caption "Scan with any UPI app".
     - **Bank transfer** — Account name, Bank name, Account number (Copy), IFSC (Copy); each with a labeled row.
  4. **Explainer box:** "**This page does not collect payment.** Pay using one of the methods above in your own bank or UPI app. [Employer name] will confirm once they receive it."
  5. **Footer:** "Questions? Contact [employer display name]." (name only — no phone/email beyond what snapshot holds; none in V1), small "Payment request details are private to you." No branding links, no employer app links.
- **Behaviors:** Opening the page and tapping Open UPI app/Copy change nothing. No "I've paid", no UTR field, no login, no account, no live outstanding, no other invoices, no internal IDs in URL, text, or alt tags. Account number is shown fully only for enabled bank method.
- **Precedence rule (evaluated top-down; first match wins):**
  | # | Condition | Page shown |
  |---|---|---|
  | 1 | Invalid / unknown / malformed token | Generic **invalid-link** page |
  | 2 | Request is **REVOKED** | **Inactive** page |
  | 3 | Collection is **CANCELLED** | **Inactive** page |
  | 4 | Request ACTIVE **and** collection **PAID** | "**Payment received — thank you.**" |
  | 5 | Request ACTIVE **and** collection not PAID | The **immutable snapshot** (active payment page) |
  Consequences: a request that was explicitly revoked stays inactive **even if the collection is later paid** — it never becomes active again and never reveals payment details or "payment received". If a payment is voided and a PAID collection returns to unpaid, an *ACTIVE* (never-revoked) request goes back to showing its snapshot (rule 5). Employers who want a revoked-then-paid link to read "Payment received" cannot get that (by design); they simply don't revoke.
- **States:**
  | State | Content |
  |---|---|
  | **Loading** | Skeleton of header + amount card (≤1s) |
  | **Active** (rule 5) | as above |
  | **Revoked** (rule 2) | icon ⓘ, title "This payment request is no longer active", text "Please contact [employer display name from the snapshot] for a new request." No amount/details/paid information shown. |
  | **Paid** (rule 4: active request + paid collection) | ✓ icon, "Payment received — thank you.", employer name; no payment details shown |
  | **Cancelled** (rule 3) | ⓘ "This payment request is no longer active." same as revoked wording (no mention of cancellation internals) + contact line |
  | **Invalid token / not found** (rule 1) | generic "This link isn't valid. Please check the link or contact the person who sent it." (identical response for malformed, unknown, or otherwise unmatched tokens; no hint that the token ever existed) |
  | **Unavailable/error (server/network)** | "We can't load this page right now. Please try again in a moment." + Try again button |
  | **Rate-limited** | same generic unavailable message |
- **Edge cases:** copy failing → select-all fallback; QR image failed to load → shows "QR code unavailable" text plus other methods; no enabled method in snapshot cannot occur (creation blocked); long names wrap; print not optimized; RTL not in scope.
- **Mobile (primary use):** full-width cards, 16px gutters, copy buttons 44px tall, "Open UPI app" is a full-width button placed first when on mobile devices; QR stays visible; sticky nothing. **Desktop:** same single column centered over neutral background with QR prominent (customer scans with phone); UPI deep-link button hidden on desktop (shows "Open this page on your phone to use your UPI app" hint). **After completion:** none (static info page).

## 19. PAYMENT SETTINGS (S10)
- **Purpose:** configure what customers see on new payment requests. **Entry:** nav, "Add payment method" prompts.
- **Layout:** title "Payment details"; info alert "These details appear on **new** payment requests. Existing requests keep the details they were created with." Sections as cards (each with enable toggle):
  1. **Display name**
  2. **UPI ID**
  3. **UPI number**
  4. **QR code**
  5. **Bank transfer**
  Right column on desktop: **Live preview** ("How this will look to customers") using the same component as the S9b preview with dummy customer/amount labelled "Sample".
- **Fields:**
  | Label | Placeholder | Req | Validation | Example |
  |---|---|---|---|---|
  | Employer display name* | Name customers will recognise | Yes | 2–60 chars | Acme Traders |
  | UPI ID | name@bank | If UPI enabled | pattern `handle@provider`, no spaces | acme@okaxis |
  | UPI number | 10-digit mobile number | If enabled | 10 digits, starts 6–9 | 9876543210 |
  | QR code | Upload image | If enabled | PNG/JPG, ≤2 MB, min 300×300, readable image; shows preview with Replace/Remove | upi_qr.png |
  | Bank name | e.g. HDFC Bank | If bank enabled | 2–60 chars | HDFC Bank |
  | Account holder name | As per bank records | If enabled | 2–80 chars | Acme Traders Pvt Ltd |
  | Account number | Digits only | If enabled | 9–18 digits; confirm field "Re-enter account number" must match | 50100234567890 |
  | IFSC | e.g. HDFC0001234 | If enabled | 11 chars `^[A-Z]{4}0[A-Z0-9]{6}$`, auto-uppercase | HDFC0001234 |
  Toggles: "Show UPI ID", "Show UPI number", "Show QR code", "Show bank details" (a method can be configured but disabled). At least one method must be enabled to create requests (page shows banner "No payment method enabled — you can't create payment requests yet." until then).
- **Primary CTA:** "Save payment details". **Secondary:** Discard changes; Preview toggle on mobile.
- **Re-authentication:** on Save when *payment values changed* (not display-name only? — any payment detail), a modal: "Confirm it's you — enter your password to change payment details." (Password field w/ show/hide; Confirm/Cancel; wrong password inline error "Incorrect password."; 3 failures → "Too many attempts. Try again later."). Rationale text: "This protects your customers from payment details being changed by someone else."
- **After save — success:** toast "Payment details saved" and **outdated-requests panel** (see §16) if N>0: "**14 active payment requests** still show your previous payment details." with **Review requests** CTA; if N=0 simple success. Saved changes never alter old requests (statement shown in panel).
- **States:** *Loading:* skeleton cards. *Empty (first time):* all sections collapsed with prompts; banner "Add your payment details so customers know how to pay." *Error – save:* inline banner "Couldn't save. Your previous details are unchanged." *Validation errors:* inline per field, summary at top with anchors. *Unsaved changes:* leaving page prompts "You have unsaved changes." *QR upload error:* "This image isn't a supported format or is too small."
- **Edge cases:** disabling a method that active requests already show → note "Existing requests will still display this method." ; clearing a field of an enabled method is blocked; changing only display name still counts as a change affecting new requests only (included in outdated count).
- **Mobile:** single column; sticky bottom Save bar; preview in a "Preview" button opening a sheet. **Desktop:** form left, preview right. **After completion:** stays on S10.

## 20. RECORD PAYMENT (S9e)
- **Entry:** S9 summary card/payments tab. Modal (desktop 520px) / bottom sheet (mobile).
- **Intro text:** "Record a payment only after you've confirmed it in your bank or UPI app. It will be counted as received immediately."
- **Fields:**
  | Label | Placeholder | Req | Validation | Example |
  |---|---|---|---|---|
  | Amount received* | 0.00 | Yes | >0, ≤ current outstanding, ≤2 decimals; default = outstanding; helper "Outstanding: ₹10,000.00" | ₹4,000.00 |
  | Payment date* | DD/MM/YYYY | Yes | valid; not in the future; default today; date picker with max=today | 14/10/2026 |
  | Payment method* | Select | Yes | UPI · Bank transfer · Cash · Other; default UPI | UPI |
  | UTR / reference | Bank or UPI reference no. | No | ≤40 chars, alphanumeric; warns if duplicate of an existing payment's UTR on this collection ("This reference was already used.") — warning only | 4210987654321 |
- **Live result block** (updates as amount changes): "Amount due ₹10,000.00 · Already received ₹0.00 · This payment ₹4,000.00 → **Outstanding after: ₹6,000.00**" and "Collection will become: **Partially paid**" or "**Paid**" when outstanding 0.
- **Primary CTA:** "Record payment" (label shows amount: "Record ₹4,000.00"). **Secondary:** Cancel.
- **Errors:** amount > outstanding → "Amount can't be more than the outstanding ₹6,000.00."; future date → "Payment date can't be in the future."; amount ≤0; server failure → "Couldn't record the payment. Nothing was changed." + retry; stale outstanding (changed elsewhere) → "Outstanding changed to ₹X. Review the amount."
- **Success:** toast "Payment of ₹4,000.00 recorded"; S9 updates (outstanding, badge, payments list, History). If collection becomes PAID: green confirmation banner "Fully paid" and prompt "Revoke the payment request?" is **not** needed (page shows "Payment received" automatically).
- **Mobile:** sheet with numeric keypad for amount (inputmode decimal), date picker native. **After completion:** S9.

## 21. PARTIAL PAYMENT (UX)
- Example: Due ₹10,000.00 → record ₹4,000.00 → Verified ₹4,000.00, Outstanding ₹6,000.00; collection stays SENT/PENDING stored status, with derived **"Partially paid"** badge showing "₹4,000.00 paid"; dashboard Collected +₹4,000.
- The existing request shows the **Balance changed** notice (§16.B): "The existing payment request still asks for ₹10,000.00. You can regenerate a new request for the remaining ₹6,000.00." (not "Out of date"). The customer page is unchanged.
- **Regenerate flow:** CTA **"Regenerate for ₹6,000.00"** → S9b prefilled with requested amount = ₹6,000.00; diff list shows "Requested amount ₹10,000.00 → ₹6,000.00"; confirm; old revoked (link erased), new created, send again.
- Payments tab lists the ₹4,000 payment; money block equation shown.

## 22. VOID PAYMENT (S9f)
- **Entry:** Payments tab row → "Void". Modal "Void this payment?".
- **Shows:** payment summary (date, amount, method, UTR) and **consequences list:**
  - "This payment (₹4,000.00) will be marked **Void** and no longer counted."
  - "Outstanding will change from ₹6,000.00 to ₹10,000.00."
  - "Collection status may change (Paid → Sent, or Partially paid removed)." (shows the exact expected result)
  - "The payment stays in the list for your records and the action is saved in History."
- **Fields:** Reason* (textarea, 5–200 chars, placeholder "Why are you voiding this payment? e.g. Entered by mistake", example "Wrong customer selected"). Helper chips for common reasons are optional shortcuts (Entered by mistake · Wrong amount · Payment bounced) that fill the field — included as plain text suggestions only.
- **Primary CTA:** "Void payment" (destructive style, disabled until reason valid). **Secondary:** "Keep payment".
- **Success:** toast "Payment voided"; row greyed with VOID tag; money block recalculated; History entry. **Error:** inline retry; nothing changed.
- **Edge:** voiding on a PAID collection moves it back (SENT if a request was ever sent, else PENDING); active request unaffected.

## 23. AUDIT / HISTORY
- **Where:** S9 "History" tab/section (chronological, newest first). No separate screen. No export, no filters except a simple "Show money events only" toggle? — **No toggle** (keep minimal).
- **Row format:** icon · **Event** (plain language) · Actor ("You" / email) · Date/time (e.g., 14 Oct 2026, 4:12 PM) · detail line.
  | Event | Detail example |
  |---|---|
  | Collection imported | "From October_Collections.xlsx · row 14 · amount ₹10,000.00" (also "Imported anyway (duplicate)") |
  | Collection edited | "Amount ₹10,000.00 → ₹10,500.00; Reference INV-2041 → INV-2041-A" |
  | Payment request created / regenerated / revoked | "Requested amount ₹10,000.00" / "Replaced request from 12 Oct" |
  | Request sent | "Marked sent via WhatsApp" / "Link copied" |
  | Payment recorded | "₹4,000.00 · UPI · UTR 4210…" |
  | Payment voided | "₹4,000.00 · Reason: Entered by mistake" |
  | Collection cancelled / reopened | reason |
  | Payment settings changed (workspace-level) | shown in Settings page footer as "Last changed 14 Oct 2026 by you" and as an entry on collections whose active requests became outdated? — **No**; settings changes appear only on S10 ("Recent changes": last 5 entries: date, who, which fields — names only, not values) |
- **States:** loading skeleton; empty "No history yet."; error "Couldn't load history." + Retry. Load 20 events with "Show more".
- **Mobile:** vertical timeline cards. **Desktop:** table-like timeline in tab.

---

## 24. GLOBAL STATES (reusable patterns)
| Pattern | Spec |
|---|---|
| **Loading (page)** | Skeletons mimicking final layout; no full-page spinner. Min display 200 ms to avoid flicker |
| **Loading (action)** | Triggering button shows spinner + verb-ing label ("Saving…"), disabled; other form controls disabled |
| **Skeleton** | Grey rounded blocks with subtle shimmer; reduced-motion = static |
| **Empty** | Icon (muted), title, one-sentence explanation, one primary CTA. Never blank |
| **Error (page/section)** | Inline card: icon, "Couldn't load X.", short reason if known, **Retry** button; rest of page stays usable |
| **Success** | Toast (bottom-center mobile/top-right desktop, 5s) + in-place data update; large success screens only for Import complete and Request created |
| **Warning** | Amber alert with icon + text, left border; non-blocking |
| **Info** | Blue/slate alert with icon |
| **Confirmation (non-destructive)** | Modal: title (question), consequence sentence, primary + "Cancel"; Esc closes; focus on primary |
| **Destructive confirmation** | Red primary button labeled with the action (never "OK"); consequence list; reason field where required (void); focus starts on **Cancel** (safe) |
| **Toast** | Role=status (polite); errors role=alert; max 3 stacked; action link optional (Undo); never the only record of an important result |
| **Inline validation** | On blur + submit; message under field with icon; `aria-describedby`; summary alert at top of long forms with anchors; no validation on pristine fields until blur |
| **Network failure** | Persistent amber top banner "You're offline…"; actions needing server disabled with tooltip; auto-retry GETs on reconnect; failed POST shows retry in-place and never double-submits (idempotent) |
| **Session expiry** | Modal "Your session expired" with password field + "Sign in again" (email shown, read-only); on success returns to same screen with unsaved form state intact; if user chooses "Sign out", go to S1 with `next`. API 401 anywhere triggers this once (debounced). Import review state is server-saved |
| **Unsaved changes** | Browser/route-leave prompt on forms with edits (Settings, Edit collection, Edit row drawer) |
| **Idempotency feedback** | Double-submit blocked by disabled button; duplicate completion shows "Already done" message |

---

## 25. RESPONSIVE BEHAVIOR (breakpoints: <640 phone · 640–1023 tablet · ≥1024 desktop)
| Screen | Desktop (≥1024) | Tablet (640–1023) | Phone (<640) |
|---|---|---|---|
| Navigation | Left sidebar 240px | Icon rail 72px | Bottom tab bar (4 tabs); hidden in import flow & modals |
| Dashboard | 4 metric cards in a row; table | 2×2 cards; table | Hero card + 2×2 cards stacked; recent as cards |
| Upload | Large drop zone + recent imports table | Same, narrower | Big "Choose file" tile (no drag); imports as cards; sticky "Upload and continue" |
| Processing | Centered card | Same | Full-width card |
| Column mapping | Mapping list left, sticky preview right | Stacked, preview below | Field cards; preview in horizontally-scrollable card |
| Import review | Full table with sticky header/footer; drawer right | Table with fewer columns (Source/Email hidden → in drawer); drawer | **Row cards**; filter chips scroller + bottom-sheet filters; edit = full-screen sheet; sticky bottom bar with counts + Continue; OCR progress bar in bar |
| Duplicate compare | Side-by-side two columns in modal | Side-by-side | Stacked Existing / Incoming with "Changed" tags |
| Import confirm | Two columns | Single column | Single column, sticky CTA |
| Collections | Table w/ inline filters | Table, fewer columns (Created hidden) | Cards; filter bottom sheet; "Load more" |
| Collection detail | 2 columns, sticky summary | 2 columns narrower | Single column; sticky Outstanding + main action bar; accordion sections; "More" sheet |
| Request preview/modals | Centered modal 520–640px | Same | Full-screen sheets with sticky footer actions |
| Payment settings | Form + live preview side by side | Stacked; preview below | Single column; sticky Save bar; Preview opens sheet |
| Record payment | Modal | Modal | Bottom sheet, numeric keypad |
| Customer payment page | Centered 480px column; UPI deep-link hidden | Same | Full-width cards; **Open UPI app** button first; copy buttons 44px |
Tables never scroll horizontally except the S5 preview. No hover-only functions: tooltips have tap equivalents.

## 26. VISUAL DESIGN SYSTEM
- **Direction:** calm, trustworthy, utilitarian finance tool; generous white space; one blue accent; semantic colors reserved for status.
- **Typography:** **Inter** (system-ui fallback). Tabular numerals (`font-variant-numeric: tabular-nums`) for all money. Scale: Display 32/40 semibold (hero amount) · H1 24/32 semibold · H2 20/28 semibold · H3 16/24 semibold · Body 16/24 regular (mobile body never <16) · Small 14/20 · Caption 12/16 (min; used sparingly, never for critical info). Monospace (JetBrains Mono/ui-monospace) for UPI ID, account number, IFSC, UTR.
- **Colors (light theme; AA verified targets):**
  | Token | Hex | Use |
  |---|---|---|
  | Background | #F7F8FA | app background |
  | Surface | #FFFFFF | cards, modals |
  | Border | #D9DEE5 | dividers, inputs (3:1 against surface for inputs: #8A94A3 for input outline) |
  | Text primary | #111827 | |
  | Text secondary | #4B5563 | (7:1+) |
  | Accent / Primary | #1D4ED8 | buttons, links, focus ring (white text 7:1) |
  | Success | #15803D on #E8F5EC | Paid, Ready |
  | Warning | #B45309 on #FEF3C7 | warnings, Overdue-pending states |
  | Danger | #B91C1C on #FDECEC | errors, Overdue, destructive |
  | Info | #0E5A8A on #E6F2FA | notes, Partially paid |
  | OCR | #6D28D9 on #F1EAFE | OCR badge |
  | Neutral badge | #374151 on #EEF0F3 | Pending, Cancelled(muted) |
  Dark mode: not in MVP (single light theme).
- **Backgrounds:** app grey, content on white cards; modals with 40% dark scrim.
- **Cards:** white, 1px border, radius 12px, padding 16 (mobile) / 24 (desktop); no heavy shadows.
- **Spacing:** 4px base scale (4, 8, 12, 16, 24, 32, 48); page gutter 16 mobile / 24 tablet / 32 desktop; max content width 1200px.
- **Radius:** inputs/buttons 8px, cards 12px, modals 16px, badges full pill.
- **Shadows:** card none (border only); popovers/menus `0 4px 12px rgba(17,24,39,0.12)`; modals `0 12px 32px rgba(17,24,39,0.20)`.
- **Buttons:** Primary (filled accent), Secondary (white, accent border/text), Tertiary (text link), Destructive (filled red; for confirmation) and Destructive-outline (red text, red border; for initial triggers). Heights: 44px (mobile & default), 40px dense desktop tables. Disabled: grey fill with text 4.5:1 not required but with explanatory tooltip/inline reason. Loading state preserves width.
- **Inputs:** 44px height, 1px #8A94A3 border, 8px radius, label above (always visible), helper below, error text red with icon, focus ring 2px accent + 2px offset. Currency inputs prefixed with ₹ adornment. Select = native on mobile.
- **Tables:** header sticky, 14px text, row height 48 (desktop), zebra none, hover tint #F2F5FA, selected/active row left border accent, numeric columns right-aligned with tabular numerals.
- **Status badges (always icon + text):**
  | Badge | Style |
  |---|---|
  | Pending | neutral grey, clock icon |
  | Sent | accent-light blue, send icon |
  | Paid | green, check icon |
  | Cancelled | grey strike-through icon ✕ |
  | **Overdue** (derived) | red outline, alert icon |
  | **Partially paid** (derived) | info blue outline, half-circle icon, "₹4,000 paid" |
  | Request: Active (green dot), Revoked (grey), None (—); notices on Active: **Out of date** (amber, "!" icon), **Balance changed** (blue/info, "↻" icon) |
  | Validation: Ready (green ✓), Warning (amber !), Error (red ✕), Note (grey i), OCR (purple scan icon), Duplicate (amber copy icon) |
- **Alerts:** full-width with left 4px color bar, icon, title (bold), text, optional action; roles: `status` / `alert`.
- **Modals:** max 640px, header with title + close ✕, scrollable body, sticky footer with actions (primary right on desktop; full-width stacked on mobile with primary on top); focus trapped; scrim click closes non-destructive ones only.
- **Icons:** Lucide-style outline set, 20px (24px in nav), 1.75 stroke; icons always accompany or are labeled by text; decorative ones `aria-hidden`.
- **Motion:** 150ms ease for toggles/drawers; reduced-motion respected; no decorative animation.
- **Money formatting:** `₹10,000.00`, negative never shown; zero `₹0.00`.

## 27. ACCESSIBILITY
- **Standard:** WCAG 2.2 AA.
- **Keyboard:** all functions operable; logical tab order; visible 2px focus ring (accent, 3:1 vs adjacent); skip-to-content link; modals trap focus and restore it to the trigger on close; Esc closes modals/drawers; review table supports ↑/↓ row navigation, Enter opens drawer, A/R keys disabled for OCR rows to avoid accidental bulk speed-accept? — **No letter shortcuts for accept** (prevents accidental decisions); only buttons.
- **Contrast:** text ≥4.5:1, large text/UI components ≥3:1; status never by color alone (icon + text).
- **Labels & forms:** persistent visible labels; required marked with `*` and "Required" in `aria-required`; helper text via `aria-describedby`; error messages specific ("Enter an amount greater than ₹0") and linked; on submit failure, focus the error summary or first invalid field; correct `inputmode`/`autocomplete` (email, tel, decimal).
- **Screen readers:** semantic landmarks (header/nav/main); tables with proper headers (`scope`), card lists use list semantics on mobile; live regions for toasts, processing progress ("Reading file", "Ready for review"), summary count updates in review; badges have text equivalents ("Warning: invalid phone number"); icon-only buttons have `aria-label`; copy buttons announce "Copied".
- **Touch targets:** ≥44×44 CSS px incl. spacing; ≥8px gap between adjacent targets (Accept/Reject).
- **Motion/zoom:** supports 200% zoom and 320px width without horizontal scroll (except S5 preview); respects reduced motion; no content flashing.
- **Timing:** session-expiry warning is non-timed for completion (modal); toasts persistent for errors; no auto-advancing carousel.
- **Customer page extras:** QR has descriptive alt text ("UPI QR code for Acme Traders") and the UPI ID is provided as text alternative; copy buttons keyboard accessible; large readable amounts; works with browser translation.

---

## 28. COMPLETE USER JOURNEYS
**A — First import.** S1 Login → S2 Dashboard (empty state) → "Upload your first file" → S3 choose `October.xlsx` → progress → S4 steps → (columns clear) → S6 summary "127 detected · 119 ready · 8 need review" → filter "Needs review" → open drawer, fix 3 phone numbers, reject 1 row → "Accept all ready rows" → Blockers panel clear → "Continue to confirmation" → S7 summary → "Create 117 collections" → success screen → "View collections" → S8 filtered to this import. Dashboard now shows outstanding.
**B — Send payment request.** S8 → open collection → S9 → "Generate request" → S9b preview (exact customer view + snapshot notice) → tick "I've checked these details" → "Create request" → success step with link → "Send via WhatsApp" → message preview → "Open WhatsApp" → return → "Did you send the message?" Yes → status Sent; History logs. (SMS and Copy link analogous.) **Later visit:** employer reopens the collection → request section shows Active → taps Copy link / WhatsApp / SMS → the same existing link is fetched securely on demand (no new request).
**C — Customer payment.** Customer taps link from WhatsApp → S11 (precedence rule 5: active request, collection unpaid) loads → reads amount/reference → chooses UPI: copies UPI ID or taps "Open UPI app" (mobile) or scans QR → pays in own app → closes. Nothing changes in the system; page keeps the same details if reopened.
**D — Employer records payment.** Employer sees credit in bank app → S9 → "Record Payment" → amount prefilled ₹10,000.00, date today, method UPI, UTR → live result "Outstanding after ₹0.00 · Collection will become Paid" → "Record ₹10,000.00" → toast → badge Paid, outstanding ₹0.00, customer page now shows "Payment received."
**E — Partial payment.** Due ₹10,000 → Record Payment amount edited to ₹4,000 → result "Outstanding after ₹6,000.00 · Partially paid" → confirm → S9 shows Partially paid, request shows **Balance changed** notice "still asks ₹10,000… remaining ₹6,000" → **"Regenerate for ₹6,000.00"** → preview diff ₹10,000 → ₹6,000 → confirm → old revoked, new created → Send via WhatsApp.
**F — Payment-detail change.** S10 → change UPI ID → Save → password re-auth modal → success toast + panel "14 active payment requests still use your previous details" → "Review requests" → S8 filtered Out of date → open each → "Regenerate request" (diff shows UPI ID change) → confirm → resend. Count decreases; Settings dot disappears at zero. Old customer links meanwhile continue showing old details until regenerated/revoked.
**G — OCR import.** S3 upload scanned PDF → S4 shows scanned-document notice → S6 with purple OCR banner (42 rows, 0 reviewed) → open row 1 drawer: compare source snippet vs read values, fix amount → "Save and accept" → "Next unreviewed OCR row" repeated; rejects unreadable rows → progress "42/42 reviewed" → Continue enabled → S7 shows "OCR rows accepted after review: 38" → Create collections. Attempting Continue early opens Blockers panel "30 scanned records haven't been reviewed."
**H — Duplicate.** S3 upload → (file hash match → warning, "Upload anyway") → S6 shows 6 Duplicate rows (default Skip) → "Review Existing" on one → S6a compares existing vs incoming (amount differs, marked Changed) → close → choose Skip for 4, Import Anyway for 2 → S7 lists "Duplicates skipped 4 · imported anyway 2" → confirm.

## 29. EDGE CASES (consolidated)
1. File with 0 valid rows; 2,000+ rows (blocked at limit message "Files over ~2,000 rows aren't supported yet. Split the file."); header rows repeated mid-file (ignored rows listed as Info "Header row skipped").
2. Same customer appears many times with different phones → customer matching shows Info "Matched existing customer"; conflicting phone is a warning, employer picks phone in drawer.
3. Missing phones: collection imports; WhatsApp/SMS disabled; Dashboard strip counts them.
4. Ambiguous dates (03/04/2026) → resolver offering both interpretations; unresolved = warning, import with blank due date allowed.
5. Amount formats (₹1,25,000, Rs. 1200, (500)) normalized with Info note; negative → error "Amount must be greater than ₹0."
6. Editing a collection after request sent (§S9a) and after payments (amount floor).
7. Cancelling a collection with an active request (auto-revoke) and with payments (retained).
8. Voiding the only payment on a PAID collection.
9. Regenerate when outstanding is ₹0 → not offered.
10. Payment settings with no enabled method → Generate blocked.
11. Two browser tabs: second tab action on stale data returns a friendly "This changed in another tab. Reloaded latest" toast and refreshes.
12. Customer opens revoked/old link after regeneration → generic inactive page (does not reveal new link or amount).
13. Link shared widely: page exposes only snapshot info (name, amount, reference, payment instructions) — noted in Settings help text "Anyone with the link can see these details."
14. Clipboard/deeplink unsupported devices (copy fallbacks).
15. Long customer names, very large amounts, RTL not supported (documented).
16. Session expiry during Record Payment: form data retained after re-auth; payment is submitted only once (idempotency key).
17. Upload interrupted / duplicate batch resumed from Recent imports.
18. Recent imports in "Processing" state > 10 minutes → shows "Taking longer than expected. Try again" action.

---

## 30. FINAL STAGE 2 DELIVERABLE MAP
1. Information architecture — §1. 2. Navigation structure — §1 (+§25). 3. Screen inventory — §3. 4. Screen specs — §4 + §§10–23. 5. Component/state definitions — §24, §26 (badges, alerts, modals, toasts), S6 states. 6. Desktop behavior and 7. Mobile behavior — per screen + §25. 8. Visual design system — §26. 9. Accessibility — §27. 10. Journeys — §28. 11. Edge cases — §29 + per-screen. 12. Stage 3 readiness — below.

### Stage 3 Readiness Checklist — every approved Stage 1 workflow → UI spec
```
Stage 1 workflow / requirement                                   UI spec        Status
Login / session / expiry                                         S1, S12, §24   [READY]
Dashboard (5 metrics, recent collections, empty/first/after)     S2             [READY]
Upload (5 formats, size, invalid, duplicate file)                S3             [READY]
Processing states + failures + retry                             S4             [READY]
Column mapping (suggest/confidence/alternatives/unmapped)        S5             [READY]
Review (edit/accept/reject/filter/search, error/warn/info)       S6             [READY]
OCR: badge, confidence, per-row accept, NO bulk accept, blocker  §10, S6        [READY]
Duplicates: Skip / Import Anyway / Review Existing only          §11, S6a       [READY]
Import confirmation with exact counts                            S7             [READY]
Collections list (statuses + derived Overdue/Partially paid)     S8             [READY]
Collection detail + approved actions only                        S9, S9a–g      [READY]
Payment request generation with snapshot preview + confirm       §15 / S9b      [READY]
"Out of date" notice (info changes; no auto-revoke) + Settings   §16.A, S10     [READY]
  outdated count
"Balance changed" notice + "Regenerate for ₹X" CTA               §16.B, §21     [READY]
Manual WhatsApp / SMS / Copy link (message preview, no provider) §17 / S9c      [READY]
Copy/send the SAME active link later (secure on-demand "get      S9, S8, §17    [READY — requires Stage 1
  link", no second request, erased on revoke)                                    token-storage amendment, see box]
Customer payment page precedence (invalid→revoked→cancelled→     S11            [READY]
  paid→snapshot); revoked never reactivates
Customer payment page (6 states, no I've-paid/UTR/gateway)       §18 / S11      [READY]
Payment settings (methods, validation, preview, re-auth)         §19 / S10      [READY]
Record Payment single-step VERIFIED, validations                 §20 / S9e      [READY]
Partial payment + regenerate for remaining                       §21            [READY]
Void payment with reason and consequences                        §22 / S9f      [READY]
Cancel / reopen collection (auto-revoke)                         S9g            [READY]
History / audit (simple)                                         §23            [READY]
Global states, responsive, accessibility, design system          §24–27         [READY]
Journeys A–H                                                     §28            [READY]
Single workspace UI, no new features, no tenant switcher         §1             [READY]
Open product defaults still pending from Stage 1 (retention/AI   Stage 1 W1–W4  [NEEDS DECISION*]
 policy, market, link expiry, login method, snapshot-after-
 partial default) — *UI is built on the stated defaults
```
Items flagged for your attention in this stage (no scope change, but worth confirming): (a) the "Did you send it?" prompt that moves PENDING→SENT after manual send (needed because manual sends can't be observed); (b) the required "I've checked these details" checkbox on request creation; (c) per-row Accept for OCR with no keyboard shortcuts; (d) the small Recent imports list; (e) no bulk regenerate for outdated requests in V1.

---

**Pending confirmations for Stage 3 (not blockers):** (1) approve the Stage 1 token-storage amendment (encrypted token column + hash lookup, erased on revoke); (2) my interpretation that an edit of the collection's *amount due* produces **Balance changed**, while name/reference/employer display name/payment details produce **Out of date**; (3) Stage 1 open defaults (retention/AI policy, India/INR, no link expiry, email+password).

**STAGE 2 — APPROVED**
