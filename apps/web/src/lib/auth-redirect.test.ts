import { describe, expect, it } from 'vitest'
import { normalizeAuthRedirect, readAuthRedirect, safeNext } from '@/lib/auth-redirect'

const loc = (search: string, hash: string) => ({ pathname: '/', search, hash })

describe('normalizeAuthRedirect (auth email links vs hash routing)', () => {
  it('leaves a successful PKCE return alone: code in the query, route intact in the hash', () => {
    expect(normalizeAuthRedirect(loc('?sb_flow_id=abc&code=123', '#/reset-password'))).toBeNull()
  })

  it('leaves normal in-app URLs alone', () => {
    expect(normalizeAuthRedirect(loc('', '#/collections'))).toBeNull()
    expect(normalizeAuthRedirect(loc('', ''))).toBeNull()
  })

  it('repairs the route when an auth ERROR redirect replaced the hash (verified GoTrue behaviour)', () => {
    const fixed = normalizeAuthRedirect(
      loc(
        '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&sb=',
      ),
    )
    expect(fixed).toBe(
      '/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid#/reset-password',
    )
  })

  it('carries error details from the hash into the query when only the hash has them', () => {
    const fixed = normalizeAuthRedirect(loc('', '#error=access_denied&error_code=otp_expired&sb='))
    expect(fixed).toBe('/?error=access_denied&error_code=otp_expired#/reset-password')
  })

  it('drops implicit-flow tokens from the URL entirely and never routes them anywhere', () => {
    const fixed = normalizeAuthRedirect(
      loc('', '#access_token=SECRET&refresh_token=SECRET2&type=recovery'),
    )
    expect(fixed).toBe('/?error_code=unsupported_flow#/reset-password')
    expect(fixed).not.toContain('SECRET')
  })

  it('sends a bare recovery code (no route) to the reset page', () => {
    expect(normalizeAuthRedirect(loc('?code=xyz', ''))).toBe('/?code=xyz#/reset-password')
  })

  it('ignores unrelated non-route hashes', () => {
    expect(normalizeAuthRedirect(loc('', '#section-2'))).toBeNull()
  })
})

describe('readAuthRedirect', () => {
  it('reads code, flow id and error details', () => {
    expect(readAuthRedirect('?code=c1&sb_flow_id=f1')).toEqual({
      code: 'c1',
      flowId: 'f1',
      errorCode: null,
      errorDescription: null,
    })
    expect(
      readAuthRedirect('?error=access_denied&error_code=otp_expired&error_description=x').errorCode,
    ).toBe('otp_expired')
    expect(readAuthRedirect('?error=server_error').errorCode).toBe('unknown_error')
  })
})

describe('safeNext (no open redirects, no login loops)', () => {
  it.each([
    ['/collections', '/collections'],
    ['/collections?status=paid', '/collections?status=paid'],
    [null, '/'],
    ['', '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/login', '/'],
    ['/login?next=/x', '/'],
    ['/reset-password', '/'],
    ['/forgot-password', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected)
  })
})
