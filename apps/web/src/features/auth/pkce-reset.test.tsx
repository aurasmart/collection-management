/**
 * Regression tests for the Phase 0 risk: Supabase password recovery (PKCE) vs React Router HASH routing.
 *
 * The REAL supabase-js client (flowType: 'pkce') and the REAL hash router run against a fake GoTrue whose
 * redirect construction mirrors supabase/auth v2.197 (internal/api/verify.go):
 *   success: redirect_to + ?code=<code> in the QUERY, the URL fragment preserved
 *   failure: error params in the query AND the fragment REPLACED by `#error=...&sb=`
 * Real-GoTrue verification is documented in docs/adr/0005-password-reset-pkce-hash-router.md.
 */
import { createHash } from 'node:crypto'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAuthRedirect } from '@/lib/auth-redirect'
import { json, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const actual = await vi.importActual<{ createSupabase: (u: string, k: string) => unknown }>(
    '@/lib/supabase',
  )
  return { ...actual, supabase: actual.createSupabase('https://auth.test', 'anon-key') }
})

const CODE = 'one-time-code-123'
const NEW_PASSWORD = 'a-brand-new-password'

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface Recovery {
  challenge: string
  method: string
  redirectTo: string
}

function fakeGoTrue() {
  const state = {
    recoveries: [] as Recovery[],
    exchanges: [] as Array<{ code: string; verifierOk: boolean }>,
    codeUsed: false,
    passwordUpdates: [] as string[],
  }
  const session = {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'owner@acme.test',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = new URL(req.url)
      const path = url.pathname.replace('/auth/v1', '')
      const body =
        req.method === 'GET'
          ? null
          : await req
              .clone()
              .json()
              .catch(() => null)
      if (path === '/recover') {
        state.recoveries.push({
          challenge: body.code_challenge,
          method: body.code_challenge_method,
          redirectTo: url.searchParams.get('redirect_to') ?? '',
        })
        return json({})
      }
      if (path === '/token' && url.searchParams.get('grant_type') === 'pkce') {
        const rec = state.recoveries.at(-1)
        const digest = b64url(
          createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest(),
        )
        const verifierOk =
          !!rec &&
          (rec.method === 's256' ? digest === rec.challenge : body.code_verifier === rec.challenge)
        state.exchanges.push({ code: body.auth_code, verifierOk })
        if (body.auth_code !== CODE || state.codeUsed || !verifierOk) {
          return json(
            { code: 400, error_code: 'flow_state_not_found', msg: 'invalid flow state' },
            400,
          )
        }
        state.codeUsed = true
        return json(session)
      }
      if (path === '/user' && req.method === 'PUT') {
        if (req.headers.get('authorization') !== 'Bearer fake-access-token')
          return json({ msg: 'no' }, 401)
        state.passwordUpdates.push(body.password)
        return json(session.user)
      }
      if (path === '/token') return json(session) // refresh
      return json({ msg: `unmocked ${req.method} ${path}` }, 500)
    }),
  )
  /** What GoTrue's verify endpoint does after the user clicks the emailed link. */
  const clickEmailLink = (redirectTo: string, code = CODE) => {
    const u = new URL(redirectTo)
    u.searchParams.set('code', code) // prepPKCERedirectURL: q.Set("code"); u.RawQuery = ...; fragment untouched
    return u
  }
  return { state, clickEmailLink }
}

/** supabase-js keeps the session under sb-<project>-auth-token. */
function storedSession(): string | null {
  const key = Object.keys(window.localStorage).find((k) => k.endsWith('-auth-token'))
  return key ? window.localStorage.getItem(key) : null
}

function land(u: URL) {
  window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`)
  // main.tsx runs this before the router is created
  const fixed = normalizeAuthRedirect(window.location)
  if (fixed) window.history.replaceState(null, '', fixed)
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('password reset: PKCE + Supabase + hash router', () => {
  it('request -> emailed link -> code exchange -> new password, end to end', async () => {
    const gotrue = fakeGoTrue()

    // 1. The user requests a reset from the real forgot-password screen.
    window.history.replaceState(null, '', '/#/forgot-password')
    const first = renderApp('/', { hash: true })
    await userEvent.type(await screen.findByLabelText(/email/i), 'owner@acme.test')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(
      await screen.findByText(/If this email is registered, a reset link has been sent/),
    ).toBeInTheDocument()
    first.unmount()

    const rec = gotrue.state.recoveries[0]!
    expect(rec.method).toBe('s256') // never the weak 'plain' method
    const redirect = new URL(rec.redirectTo)
    expect(redirect.hash).toBe('#/reset-password') // our route survives inside redirect_to
    // auth-js can append `sb_flow_id` before the fragment, but only behind an experimental flag we do not enable;
    // by default the verifier lives in a single slot and the exchange needs no flow id.
    expect(redirect.searchParams.has('sb_flow_id')).toBe(false)

    // 2. The user clicks the link in their email (same browser, so the verifier is in localStorage).
    land(gotrue.clickEmailLink(rec.redirectTo))
    expect(window.location.hash).toBe('#/reset-password')
    expect(window.location.search).toContain('code=')

    // 3. The app boots on that URL with the REAL hash router.
    const { router } = renderApp('/', { hash: true })
    expect(await screen.findByLabelText(/^new password/i)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reset-password')

    // exactly one exchange, with a verifier matching the S256 challenge
    expect(gotrue.state.exchanges).toEqual([{ code: CODE, verifierOk: true }])
    // the one-time code is gone from the address bar; the route is intact
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#/reset-password')
    expect(storedSession()).toBeTruthy() // recovery session stored

    // 4. Set the new password.
    await userEvent.type(screen.getByLabelText(/^new password/i), NEW_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^confirm new password/i), NEW_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
    expect(gotrue.state.passwordUpdates).toEqual([NEW_PASSWORD])
  })

  it('exchanges the code exactly once even under React StrictMode (double effects)', async () => {
    const gotrue = fakeGoTrue()
    const rec = await requestReset(gotrue)
    land(gotrue.clickEmailLink(rec.redirectTo))
    renderApp('/', { hash: true, strict: true })
    expect(await screen.findByLabelText(/^new password/i)).toBeInTheDocument()
    expect(gotrue.state.exchanges).toHaveLength(1)
  })

  it('an auth ERROR redirect (hash replaced by #error=...) is repaired and explained', async () => {
    fakeGoTrue()
    land(
      new URL(
        'http://localhost:3000/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
      ),
    )
    const { router } = renderApp('/', { hash: true })
    expect(await screen.findByText(/This reset link has expired/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reset-password') // not a 404, not the dashboard
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument()
    expect(window.location.search).toBe('') // error params scrubbed from the URL
  })

  it('opening the link in a DIFFERENT browser (no stored verifier) explains what to do', async () => {
    const gotrue = fakeGoTrue()
    const rec = await requestReset(gotrue)
    window.localStorage.clear() // another browser/profile has no code verifier
    land(gotrue.clickEmailLink(rec.redirectTo))
    renderApp('/', { hash: true })
    expect(await screen.findByText(/same browser where you requested it/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^new password/i)).not.toBeInTheDocument()
  })

  it('a reused or forged code is rejected without signing anyone in', async () => {
    const gotrue = fakeGoTrue()
    const rec = await requestReset(gotrue)
    land(gotrue.clickEmailLink(rec.redirectTo, 'forged-code'))
    renderApp('/', { hash: true })
    expect(await screen.findByText(/invalid or has already been used/)).toBeInTheDocument()
    expect(storedSession()).toBeNull()
  })

  it('implicit-flow tokens in the hash are never used and are scrubbed from the URL', async () => {
    const gotrue = fakeGoTrue()
    land(new URL('http://localhost:3000/#access_token=LEAKED&refresh_token=LEAKED2&type=recovery'))
    renderApp('/', { hash: true })
    expect(await screen.findByText(/not supported/)).toBeInTheDocument()
    expect(window.location.href).not.toContain('LEAKED')
    expect(storedSession()).toBeNull()
    expect(gotrue.state.exchanges).toHaveLength(0)
  })

  it('a reload after a successful exchange (no code in the URL) keeps the recovery form available', async () => {
    const gotrue = fakeGoTrue()
    const rec = await requestReset(gotrue)
    land(gotrue.clickEmailLink(rec.redirectTo))
    const first = renderApp('/', { hash: true })
    await screen.findByLabelText(/^new password/i)
    first.unmount()
    renderApp('/', { hash: true }) // URL is now just /#/reset-password
    expect(await screen.findByLabelText(/^new password/i)).toBeInTheDocument()
    expect(gotrue.state.exchanges).toHaveLength(1)
  })

  it('enforces the password rules before calling Supabase', async () => {
    const gotrue = fakeGoTrue()
    const rec = await requestReset(gotrue)
    land(gotrue.clickEmailLink(rec.redirectTo))
    renderApp('/', { hash: true })
    await userEvent.type(await screen.findByLabelText(/^new password/i), 'short')
    await userEvent.type(screen.getByLabelText(/^confirm new password/i), 'different')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument()
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
    await waitFor(() => expect(gotrue.state.passwordUpdates).toHaveLength(0))
  })
})

/** Drive the real forgot-password screen and return what Supabase was asked to do. */
async function requestReset(gotrue: ReturnType<typeof fakeGoTrue>): Promise<Recovery> {
  window.history.replaceState(null, '', '/#/forgot-password')
  const view = renderApp('/', { hash: true })
  await userEvent.type(await screen.findByLabelText(/email/i), 'owner@acme.test')
  await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
  await screen.findByText(/reset link has been sent/)
  view.unmount()
  return gotrue.state.recoveries.at(-1)!
}
