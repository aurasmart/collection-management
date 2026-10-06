# ADR 0004 — Re-authentication for sensitive payment-setting changes (Phase 1)

**Status:** Implemented in Phase 1. Implementation choice within Stage 3 §3.1 ("re-auth … verified via Supabase");
flagged for owner review because the wording differs slightly (see "Alternative").

## Rule (Stage 1 §V.3, Stage 2 S10)
Changing payment details requires a recent password confirmation. A change to **any payment detail** is
sensitive: UPI ID, UPI number, bank name/holder/account number/IFSC, QR upload/replace/remove, and the four
"show to customers" switches. Changing only the display name is not sensitive.

## Mechanism
1. The browser asks for the password in a modal and calls Supabase `signInWithPassword` for the signed-in user.
   Supabase issues a new access token whose `amr` claim contains `{ method: "password", timestamp: <unix> }`.
2. The API (`app/core/reauth.py`) accepts a sensitive mutation only if the latest `amr` password timestamp in the
   **verified** JWT is at most `REAUTH_MAX_AGE_SECONDS` old (default 300). Otherwise it answers
   `403 {"detail": {"code": "reauth_required"}}` and changes nothing; the UI then asks again.
3. The server decides what is sensitive by diffing the request against the stored row. The client check is only UX.
4. The password never passes through our API or logs. Token refresh does **not** refresh the `amr` timestamp
   (verified live against GoTrue v2.197), so a long-lived session cannot silently satisfy the gate.

## Alternative (not chosen)
Send the password to the API and verify it server-side against Supabase. Rejected: it moves credentials through
our logs/proxies for no security gain over the signed timestamp.

## Not covered
Supabase MFA/AAL levels (not in V1 scope).
