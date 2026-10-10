# ADR 0005 — Password reset: Supabase PKCE vs hash routing (Phase 1 verification)

**Status:** Verified. No change to the approved hash-router architecture was needed.

## Question (raised in Phase 0)
Does Supabase password recovery (PKCE) work with a hash-routed SPA (`/#/reset-password`)?

## Findings
Verified three ways: (1) supabase/auth v2.197 and auth-js 2.117 source; (2) the committed regression suite
`apps/web/src/features/auth/pkce-reset.test.tsx` (real supabase-js client + real React Router hash router + a fake
GoTrue that mirrors the source); (3) a **live run of the real GoTrue binary** (supabase/auth v2.197 built from source,
behind a path-mapping shim for `/auth/v1`, real SMTP sink) driven by headless Chrome (24 checks, all passed).

| Case | What GoTrue really does | Effect on the app |
|---|---|---|
| Success | `redirect_to=https://app/#/reset-password` becomes `https://app/?code=<code>#/reset-password`. The `code` is appended to the **query**; the fragment is preserved. | Router keeps `/reset-password`; page exchanges `code` (PKCE S256), then removes it from the URL. |
| Error (expired / reused / invalid link) | `https://app/?error=access_denied&error_code=otp_expired&error_description=…#error=…&error_code=…&sb=` — the **fragment is replaced** with error params. | Without a fix the router would lose its route. `normalizeAuthRedirect()` (run in `main.tsx` before the router starts) restores `#/reset-password`; the page shows a friendly message. |
| Implicit-flow tokens (`#access_token=…`) | Not requested (we use PKCE). | Never used; dropped from the URL and reported as unsupported. |
| Link opened in another browser/profile | No code verifier in that browser's storage. | Page explains to use the requesting browser. NOTE: the click already consumed the one-time token, so a new link is needed. |

Other facts established
- auth-js can append `sb_flow_id` before the fragment only behind an experimental flag we do not enable; default flow works.
- The recovery code is single-use; React StrictMode runs effects twice, so concurrent exchanges are de-duplicated and
  never cached after settling.
- `signOut()` defaults to scope `global` (all devices); the app uses `scope: 'local'`.
- Token refresh keeps the original `amr` password timestamp (see ADR 0004).

## Required Supabase configuration (see docs/runbook.md)
Add the exact app URL (including `/#/reset-password`) to *Redirect URLs*; disable sign-ups; set minimum password length 8.

## Limits of this verification
Verified against self-built open-source GoTrue, **not a hosted Supabase project**. The hosted gateway, hosted SMTP,
Storage and project-level settings were not exercised.
