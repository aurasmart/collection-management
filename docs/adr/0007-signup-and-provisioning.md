# ADR 0007 — Employer sign-up and operator provisioning

Status: accepted (owner request, supersedes the "no signup UI" rule in ADR 0003 A6)

## Decision
- **Self sign-up** uses Supabase Auth's own `signUp` from the browser (public anon key only). The form's
  full name, company name and optional phone travel as Supabase *user metadata*.
- The **workspace is created by the API on the first signed-in request** (`POST /api/v1/account/setup`,
  triggered automatically when `/me` answers 403 "no workspace"). It takes **no input**: the user id and
  email come from the verified JWT, the names from that same JWT's `user_metadata`. The employer id is
  generated server-side. One transaction creates `employers` (name = full name), `company_profiles`
  (display name = company name) and `payment_settings`; a failure creates nothing and can be retried.
- Because the workspace is built from a **signed-in** identity, no employer exists for an unconfirmed email,
  no service-role key is needed on the sign-up path, and an auth user without a workspace is a valid
  "not set up yet" state, not a broken tenant.
- **Operator provisioning** (`python -m app.provisioning create --full-name … --company … --email …`)
  is an admin-only CLI on a trusted machine using the backend-only service-role key. It shares
  `app/workspace.py::create_workspace` with sign-up, so both paths produce identical rows.
  There is no HTTP admin endpoint.

## Security
- `employer_id` is never accepted from a request. `user_metadata` is user-editable, but it is only used to
  *name the user's own new workspace*; it never grants access to anything.
- Duplicate email: Supabase refuses it (the browser reads both the error and the empty-identities answer),
  and `create_workspace` refuses an email already owned by another auth user.
- Rate limiting for sign-up itself is Supabase Auth's (per-IP and per-email limits). Keep them enabled.
- Password rules: 8+ characters, enforced in the form; set the same minimum in the Supabase project.

## Required Supabase project settings
"Enable email signups" ON; "Confirm email" ON (recommended); Site URL and Redirect URLs include the app
address (confirmation links return to `/#/login?confirmed=1`); minimum password length 8.

## Not changed
No migration. Existing accounts are untouched (`create_workspace` is idempotent per auth user).
