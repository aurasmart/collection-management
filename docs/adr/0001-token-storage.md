# ADR 0001 — Payment token storage (amends Stage 1 §N / R3)

**Status:** Approved (Stage 2 review, Correction 1).

**Problem.** Stage 1 stored only a token hash, which makes "Copy link / WhatsApp / SMS later" impossible without creating a second request.

**Decision.**
1. Token = `secrets.token_urlsafe(32)` (256-bit CSPRNG).
2. `payment_requests.token_hash` — HMAC-SHA256(token, `TOKEN_HMAC_SECRET`), unique; used by the public page for lookup.
3. `payment_requests.token_ciphertext` + `token_key_id` — AES-256-GCM(token, `TOKEN_ENC_KEY`), for **authenticated employer-side retrieval only**.
4. Ciphertext is **erased (NULL)** on revoke / regenerate / cancel. A DB CHECK enforces `status = 'ACTIVE'  ⇔  token_ciphertext IS NOT NULL`; a trigger forbids any other change to the token/snapshot columns.
5. Token and ciphertext never appear in list/detail/dashboard responses, logs, or audit events. Retrieval is a dedicated authenticated "get existing link" endpoint (Phase 4).
6. `TOKEN_ENC_KEY` and `TOKEN_HMAC_SECRET` are backend-only. Key rotation via `token_key_id`.

**Phase 0 status:** columns, constraints, trigger and crypto primitives exist; no payment-request feature yet.
