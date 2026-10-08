# Runbook

## Architecture in production
| Part | Where | Notes |
|---|---|---|
| Web app (static, hash-routed) | **GitHub Pages** | built by `.github/workflows/deploy-web.yml` |
| API | **Railway** (Docker, `apps/api`) | `apps/api/railway.json`; Tesseract is in the image |
| Database, Auth, private file storage | **Supabase** | row-level security; bucket `qr` is private |

Customer payment links look like `https://<owner>.github.io/<repo>/#/pay/<token>`.
Keep local, staging and production in **separate** Supabase projects and Railway services; never share secrets.

## Deploy order (first time)
Do these in order: later steps need values from earlier ones.

### 1. Supabase
1. Create a project. Note the **project ref** (the `abcd1234` in `https://abcd1234.supabase.co`).
2. **Project Settings → Database → Connection string → _Session pooler_** (IPv4, port 5432). Use this as `DATABASE_URL`
   (replace `[YOUR-PASSWORD]`). Railway has no IPv6, so the *direct* connection will not work; do **not** use the
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

### 2. Railway (API)
1. **New Project → Deploy from GitHub repo →** `aurasmart/collection-management`.
2. Service **Settings → Source → Root Directory = `apps/api`** (it then finds `Dockerfile` and `railway.json`).
3. **Variables** (names only here; values are yours):

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

4. **Settings → Networking → Generate Domain.** That is your API URL, e.g. `https://collections-api.up.railway.app`.
5. Deploy. Railway builds the image, runs `alembic upgrade head` as the **pre-deploy command**, then health-checks `/healthz`.

### 3. GitHub (web)
1. **Settings → Pages → Source: GitHub Actions.** (A *private* repository needs a paid GitHub plan for Pages; otherwise make the
   repository public. No secrets are stored in it.)
2. **Settings → Secrets and variables → Actions → Variables** (public values only):
   `VITE_API_URL` = the Railway URL, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the **anon** key, never the service key).
   `VITE_BASE_PATH` and `VITE_PUBLIC_APP_URL` default to `/<repo>/` and `https://<owner>.github.io/<repo>` (set them only for a
   custom domain: `/` and the full URL).
3. **Actions → Deploy web to GitHub Pages → Run workflow.**

### 4. Verify
```bash
infra/smoke-test.sh https://<railway-domain> https://<owner>.github.io/<repo>
```
Then in the browser: open the app → **Sign up** → confirm the email → sign in → Company profile → import a file → generate a
payment page → open it in a private window.

## Creating an employer by hand (operator)
From a trusted machine with the production `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`:
`cd apps/api && uv run python -m app.provisioning create --full-name "…" --company "…" --email …` (prompts for the password).

## Updating
Push to `main`: Railway redeploys the API (and migrates first); the web workflow redeploys Pages when `apps/web/**` changes.
A migration that fails stops the deploy, and the previous version keeps serving.

## Rollback
Railway → Deployments → redeploy the previous successful deployment. Migrations are forward-only: write a new migration to undo one.

## Secrets
Only `anon` (public) values go to GitHub. `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `TOKEN_*` and Google keys exist **only**
in Railway. Turn on GitHub secret scanning and push protection. Rotating the service-role key = update it in Railway and redeploy.

## Not done by design
Background workers, Redis, automated payment verification, automated WhatsApp/SMS (see ADR 0006).
