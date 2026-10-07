import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { authEvents } from '@/lib/auth-events'
import { supabase } from '@/lib/supabase'

/**
 * 'unconfigured' = no Supabase env (fresh local checkout): shown as a clear message, never a redirect loop.
 * 'expired'      = we had a session and lost it (token rejected / refresh failed / signed out elsewhere).
 */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'expired' | 'unconfigured'

export type SignInResult =
  { ok: true } | { ok: false; reason: 'invalid' | 'rate_limited' | 'network' | 'unknown' }

export type ChangePasswordResult =
  | { ok: true }
  | {
      ok: false
      reason: 'wrong_current' | 'same' | 'weak' | 'rate_limited' | 'network' | 'unknown'
    }

interface AuthState {
  status: AuthStatus
  email: string | null
}

interface AuthApi extends AuthState {
  signIn: (email: string, password: string) => Promise<SignInResult>
  /** Re-checks the current user's password (session-expiry and sensitive-change confirmation). */
  confirmPassword: (password: string) => Promise<SignInResult>
  /** Verifies the current password, then sets the new one on the existing session. */
  changePassword: (current: string, next: string) => Promise<ChangePasswordResult>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthApi | null>(null)

function toResult(
  error: { status?: number; code?: string; name?: string } | null | undefined,
): SignInResult {
  if (!error) return { ok: true }
  if (error.status === 429 || error.code === 'over_request_rate_limit') {
    return { ok: false, reason: 'rate_limited' }
  }
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
    return { ok: false, reason: 'network' }
  }
  if (error.status === 400 || error.status === 401 || error.code === 'invalid_credentials') {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: false, reason: 'unknown' }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(
    supabase ? { status: 'loading', email: null } : { status: 'unconfigured', email: null },
  )
  const emailRef = useRef<string | null>(null)
  const manualSignOut = useRef(false)

  useEffect(() => {
    if (!supabase) return
    // INITIAL_SESSION fires on subscribe, which restores the persisted session on page load.
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        emailRef.current = session.user.email ?? null
        setState({ status: 'signed-in', email: emailRef.current })
        return
      }
      if (event === 'SIGNED_OUT' && !manualSignOut.current && emailRef.current) {
        // Lost the session without the user asking: keep the page, show the expiry modal.
        setState({ status: 'expired', email: emailRef.current })
        return
      }
      emailRef.current = null
      setState({ status: 'signed-out', email: null })
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(
    () =>
      authEvents.onUnauthorized(() => {
        // The API rejected our token although we believed we were signed in.
        setState((s) => (s.status === 'signed-in' ? { status: 'expired', email: s.email } : s))
      }),
    [],
  )

  const signIn = useCallback<AuthApi['signIn']>(async (email, password) => {
    if (!supabase) return { ok: false, reason: 'unknown' }
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      return toResult(error)
    } catch {
      return { ok: false, reason: 'network' }
    }
  }, [])

  const confirmPassword = useCallback<AuthApi['confirmPassword']>(
    async (password) => {
      if (!state.email) return { ok: false, reason: 'unknown' }
      return signIn(state.email, password)
    },
    [signIn, state.email],
  )

  const changePassword = useCallback<AuthApi['changePassword']>(
    async (current, next) => {
      if (!supabase) return { ok: false, reason: 'unknown' }
      const check = await confirmPassword(current)
      if (!check.ok) {
        return { ok: false, reason: check.reason === 'invalid' ? 'wrong_current' : check.reason }
      }
      try {
        const { error } = await supabase.auth.updateUser({ password: next })
        if (!error) return { ok: true }
        const e = error as { status?: number; code?: string; name?: string }
        if (e.code === 'same_password') return { ok: false, reason: 'same' }
        if (e.code === 'weak_password') return { ok: false, reason: 'weak' }
        if (e.status === 429 || e.code === 'over_request_rate_limit') {
          return { ok: false, reason: 'rate_limited' }
        }
        if (e.name === 'AuthRetryableFetchError' || e.status === 0) {
          return { ok: false, reason: 'network' }
        }
        return { ok: false, reason: 'unknown' }
      } catch {
        return { ok: false, reason: 'network' }
      }
    },
    [confirmPassword],
  )

  const signOut = useCallback(async () => {
    if (!supabase) return
    manualSignOut.current = true
    try {
      // 'local': end THIS browser's session only. The default scope signs out every device.
      await supabase.auth.signOut({ scope: 'local' })
    } finally {
      manualSignOut.current = false
      emailRef.current = null
      setState({ status: 'signed-out', email: null })
    }
  }, [])

  const value = useMemo<AuthApi>(
    () => ({ ...state, signIn, confirmPassword, changePassword, signOut }),
    [state, signIn, confirmPassword, changePassword, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
