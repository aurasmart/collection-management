/**
 * Supabase redirects back to the app after an email link. The app uses hash routing
 * (`/#/reset-password`), so the redirect has to be understood carefully.
 *
 * What GoTrue + supabase-js do (verified against supabase/auth v2.197 and auth-js 2.117 source, and
 * against a live local GoTrue; see docs/adr/0005):
 *  - success (PKCE):  https://app/?sb_flow_id=<id>&code=<code>#/reset-password
 *      -> `code` goes in the real query string; our route in the hash survives.
 *  - failure:         https://app/?error=...&error_code=...&error_description=...#error=...&error_code=...&sb=
 *      -> the hash is REPLACED by error params, which would make the router lose the route.
 *  - implicit flow (we never request it) would put `#access_token=...` in the hash.
 */

export const RESET_ROUTE = '/reset-password'

export interface AuthRedirect {
  code: string | null
  flowId: string | null
  errorCode: string | null
  errorDescription: string | null
}

export function readAuthRedirect(search: string): AuthRedirect {
  const q = new URLSearchParams(search)
  return {
    code: q.get('code'),
    flowId: q.get('sb_flow_id'),
    errorCode: q.get('error_code') ?? (q.get('error') ? 'unknown_error' : null),
    errorDescription: q.get('error_description'),
  }
}

/** True when the hash is a router path (`#/...`) rather than auth parameters. */
function isRouteHash(hash: string): boolean {
  return hash.startsWith('#/')
}

/**
 * Returns a corrected `path + search + hash` when an auth redirect clobbered the router hash,
 * or null when nothing needs fixing. Tokens in the hash are never trusted or kept.
 */
export function normalizeAuthRedirect(loc: {
  pathname: string
  search: string
  hash: string
}): string | null {
  const { pathname, search, hash } = loc
  const query = new URLSearchParams(search)
  const hasAuthQuery = query.has('code') || query.has('error') || query.has('error_code')

  if (hash && !isRouteHash(hash)) {
    const hashParams = new URLSearchParams(hash.slice(1))
    const clobbered =
      hashParams.has('error') ||
      hashParams.has('error_code') ||
      hashParams.has('sb') ||
      hashParams.has('message')
    const implicitTokens = hashParams.has('access_token') || hashParams.has('refresh_token')
    if (implicitTokens) {
      // Tokens in a URL fragment are not part of the approved PKCE flow: drop them entirely.
      return `${pathname}?error_code=unsupported_flow#${RESET_ROUTE}`
    }
    if (clobbered || hasAuthQuery) {
      if (!hasAuthQuery) {
        // Error details only arrived in the hash: carry them over into the query.
        const carried = new URLSearchParams()
        for (const key of ['error', 'error_code', 'error_description']) {
          const v = hashParams.get(key)
          if (v) carried.set(key, v)
        }
        return `${pathname}?${carried.toString()}#${RESET_ROUTE}`
      }
      return `${pathname}${search}#${RESET_ROUTE}`
    }
    return null
  }

  // A recovery code arrived without a route (bare "#" or no hash): send it to the reset page.
  if (query.has('code') && !isRouteHash(hash)) return `${pathname}${search}#${RESET_ROUTE}`
  return null
}

/** Remove one-time auth parameters from the visible URL, keeping the hash route. */
export function scrubAuthParams(): void {
  const { pathname, hash } = window.location
  window.history.replaceState(window.history.state, '', `${pathname}${hash}`)
}

/** Only allow same-app absolute paths after login (blocks open redirects and login loops). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  if (/^\/(login|forgot-password|reset-password)(\/|\?|$)/.test(next)) return '/'
  return next
}
