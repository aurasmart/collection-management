# Runbook

## Architecture in production
| Part | Where | Notes |
|---|---|---|
| Web app (static, hash-routed) | **GitHub Pages** | built by `.github/workflows/deploy-web.yml` |
| API | **Render** web service (Docker, `apps/api`) | Tesseract is in the image; blueprint in `infra/render.yaml` |
| Database, Auth, private file storage | **Supabase** | row-level security; bucket `qr` is private |

Customer payment links look like `https://<owner>.github.io/<repo>/#/pay/<token>`.
Keep local, staging and production in **separate** Supabase projects and Render services; never share secrets.

## Deploy order (first time)
Do these in order: later steps need values from earlier ones.

### 1. Supabase
1. Create a project. Note the **project ref** (the `abcd1234` in `https://abcd1234.supabase.co`).
2. **Project Settings → Database → Connection string → _Session pooler_** (IPv4, port 5432). Use this as `DATABASE_URL`
   (replace `[YOUR-PASSWORD]`). Render has no IPv6 route to Supabase's *direct* connection, so use the pooler; do **not** use the
   *transaction* pooler (port 6543).
3. **Project Settings → API:** copy `Project URL`, the `anon` key (public) and the `service_role` key (**secret, backend only**).
4. **Authentication → Sign In / Providers → Email:** enable email sign-ups, **Confirm email = ON**, **minimum password length = 12**.
5. **Authentication → SMTP:** configure a real SMTP sender (Resend, Brevo, …). Supabase's built-in mailer is limited to a
   couple of emails per hour, which will block sign-up confirmation and password reset in real use.
6. **Authentication → URL Configuration** (after step 3 below you know the Pages address):
   *Site URL* = `https://<owner>.github.io/<repo>/` and *Redirect URLs* =
   `https://<owner>.github.io/<repo>/#/login?confirmed=1` and `https://<owner>.github.io/<repo>/#/reset-password`.
7. **Storage → New bucket** named `qr`, **Private** (no public policy). Logos and QR codes live here.
8. JWT: new projects sign tokens with asymmetric keys. `SUPABASE_JWKS_URL` =
   `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, `JWT_ISSUER` = `https://<ref>.supabase.co/auth/v1`.
   (Older projects: set `SUPABASE_JWT_SECRET` from **Project Settings → API → JWT Secret** instead.)

### 2. Render (API)
1. **New + → Web Service →** connect GitHub and pick `aurasmart/collection-management`.
2. Settings: **Language: Docker**, **Root Directory: `apps/api`**, **Region: Singapore**, **Branch: main**,
   **Health Check Path: `/healthz`**, **Auto-Deploy: On Commit**.
3. **Instance type:** *Free* works for a trial (it sleeps after ~15 minutes idle, so the first request takes about a minute).
   *Starter* ($7/month) is recommended for real use.
4. **Docker Command** (Advanced; needed on Free so the database is migrated on every start; optional on Starter, which can
   use the **Pre-Deploy Command** `alembic upgrade head` instead):
   `sh -c "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000} --proxy-headers --forwarded-allow-ips='*'"`
5. **Environment variables** (names only here; values are yours):

   | Variable | Value |
   |---|---|
   | `APP_ENV` | `production` |
   | `DATABASE_URL` | the Session pooler string from step 1.2 |
   | `CORS_ORIGINS` | the Pages **origin only**: `https://<owner>.github.io` (no path, no trailing slash) |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key (secret) |
   | `SUPABASE_JWKS_URL`, `JWT_ISSUER` | see step 1.8 |
   | `STORAGE_BACKEND` | `supabase` |
   | `QR_BUCKET` | `qr` |
   | `TOKEN_ENC_KEY` | `python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"` |
   | `TOKEN_HMAC_SECRET` | `python3 -c "import secrets;print(secrets.token_hex(32))"` |
   | `OCR_ENABLED` | `true` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | optional: private Google Sheets only (set both or neither) |

6. **Create Web Service.** Render builds the image (several minutes: it installs Tesseract), starts it, migrates the database,
   and health-checks `/healthz`. The service URL (`https://collections-api-xxxx.onrender.com`) is your API URL.

### 3. GitHub (web)
1. **Settings → Pages → Source: GitHub Actions.** (A *private* repository needs a paid GitHub plan for Pages; otherwise make the
   repository public. No secrets are stored in it.)
2. **Settings → Secrets and variables → Actions → Variables** (public values only):
   `VITE_API_URL` = the Render URL, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the **anon** key, never the service key).
   `VITE_BASE_PATH` and `VITE_PUBLIC_APP_URL` default to `/<repo>/` and `https://<owner>.github.io/<repo>` (set them only for a
   custom domain: `/` and the full URL).
3. **Actions → Deploy web to GitHub Pages → Run workflow.**

### 4. Verify
```bash
infra/smoke-test.sh https://<render-url> https://<owner>.github.io/<repo>
```
Then in the browser: open the app → **Sign up** → confirm the email → sign in → Company profile → import a file → generate a
payment page → open it in a private window.

## Creating an employer by hand (operator)
From a trusted machine with the production `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`:
`cd apps/api && uv run python -m app.provisioning create --full-name "…" --company "…" --email …` (prompts for the password).

## Updating
Push to `main`: Render redeploys the API (and migrates on start); the web workflow redeploys Pages when `apps/web/**` changes.
If a migration fails the new version does not start; use **Manual Deploy → previous commit** to roll back.

## Rollback
Render → the service → **Events/Deploys** → roll back to the previous successful deploy. Migrations are forward-only: write a new migration to undo one.

## Secrets
Only `anon` (public) values go to GitHub. `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `TOKEN_*` and Google keys exist **only**
in Render. Turn on GitHub secret scanning and push protection. Rotating the service-role key = update it in Render and redeploy.

## Not done by design
Background workers, Redis, automated payment verification, automated WhatsApp/SMS (see ADR 0006).
