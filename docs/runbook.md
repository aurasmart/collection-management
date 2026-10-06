# Runbook (Phase 0)

## Environments
local · staging · production — separate Supabase project, Render services and keys for each. Never share secrets across them.

## One-time GitHub setup
1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Note: GitHub Pages on a *private* repository requires a paid GitHub plan.
2. **Settings → Secrets and variables → Actions → Variables** (public values only):
   `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_APP_URL`, `VITE_BASE_PATH`
   (`/` for a custom domain; `/<repo>/` for `user.github.io/<repo>`).
3. **Settings → Code security**: enable *Secret scanning* and **Push protection**, Dependabot alerts.
4. **Settings → Branches**: protect `main` (PR + passing `CI` required).
5. (Optional) custom domain for Pages, "Enforce HTTPS".
The `CI` workflow also runs gitleaks; locally: `pre-commit install` (uses `.pre-commit-config.yaml`).

## Supabase
- Create the project; copy the connection string to Render as `DATABASE_URL` (backend-only).
- **Authentication → Providers:** email+password only; **disable sign-ups** (employers are operator-provisioned, ADR 0003 A6).
- **Settings → API:** the migration revokes `anon`/`authenticated` access to every table; additionally disable the Data API if not needed.
- Auth URL configuration: add the Pages URL as a redirect URL (PKCE flow; see ADR 0002 on hash routing).
- JWT: set `SUPABASE_JWKS_URL` (or `SUPABASE_JWT_SECRET`) and `JWT_ISSUER` on Render.
- Run migrations with the same DB user the API uses: `alembic upgrade head` (Render runs it as `preDeployCommand`).
  The migration creates the `app_rls` role and grants it to the migrating user.

## Render (backend + worker)
- New → Blueprint → select `infra/render.yaml`. Fill every `sync: false` variable in the dashboard
  (`DATABASE_URL`, `CORS_ORIGINS` = exactly the Pages origin, JWT settings, `TOKEN_ENC_KEY`, `TOKEN_HMAC_SECRET`, …).
- Starter instance types are required for the worker and `preDeployCommand`.
- Deploys are triggered from CI/manual (`autoDeployTrigger: off`).

## Key rotation (token crypto)
`TOKEN_ENC_KEY_ID` labels the active key. Rotation procedure is implemented with the payment-request phase (Phase 4).

## Not yet implemented (by design in Phase 0)
Employer provisioning script (Phase 1), import pipeline (Phase 2), payment requests/public page (Phase 4), retention job (Phase 7).
