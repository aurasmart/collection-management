# ADR 0002 — Hash routing for the SPA (Stage 3 A2)

**Status:** Approved for the initial implementation.

GitHub Pages has no SPA fallback. We use a hash router: `https://app.<domain>/#/pay/<token>`.
Benefit: the URL fragment is never sent to the static host, to proxies, or in `Referer`.

**Keep migration easy:**
- All route paths are built via helpers in `apps/web/src/lib/routes.ts` (no hard-coded `#/` strings).
- The payment architecture (token, hash, snapshot, API) does not depend on the URL form.
- Moving to path URLs later (custom domain / Cloudflare Pages) = switch `createHashRouter` → `createBrowserRouter` + host SPA fallback.

**Known risk (verify in Phase 1):** Supabase auth emails (password reset) return tokens in the URL hash, which collides with hash routing. supabase-js is configured with `flowType: 'pkce'` (code in the query string) to avoid this.
