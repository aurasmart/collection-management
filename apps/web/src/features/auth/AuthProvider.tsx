import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '@/lib/supabase'

/** 'unconfigured' = no Supabase env (e.g. fresh local checkout). Login UI arrives in Phase 1. */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'unconfigured'

interface AuthState {
  status: AuthStatus
  email: string | null
}

const AuthContext = createContext<AuthState>({ status: 'loading', email: null })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(
    supabase ? { status: 'loading', email: null } : { status: 'unconfigured', email: null },
  )

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setState(
        data.session
          ? { status: 'signed-in', email: data.session.user.email ?? null }
          : { status: 'signed-out', email: null },
      )
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(
        session
          ? { status: 'signed-in', email: session.user.email ?? null }
          : { status: 'signed-out', email: null },
      )
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo(() => state, [state])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  return useContext(AuthContext)
}
