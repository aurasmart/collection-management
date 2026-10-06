import { vi } from 'vitest'

/** In-memory stand-in for the supabase-js client surface the app uses (no network). */
export interface FakeSession {
  access_token: string
  user: { id: string; email: string }
}

type Listener = (event: string, session: FakeSession | null) => void

export function createFakeSupabase() {
  let session: FakeSession | null = null
  const listeners = new Set<Listener>()
  const emit = (event: string, s: FakeSession | null) => listeners.forEach((l) => l(event, s))

  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listeners.add(cb)
      // Real supabase-js reports the persisted session right after subscribing.
      setTimeout(() => cb('INITIAL_SESSION', session), 0)
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }
    }),
    signInWithPassword: vi.fn(async ({ email }: { email: string; password: string }) => {
      const next = makeSession(email)
      session = next
      emit('SIGNED_IN', next)
      return {
        data: {
          session: next as FakeSession | null,
          user: next.user as FakeSession['user'] | null,
        },
        error: null as unknown,
      }
    }),
    signOut: vi.fn(async () => {
      session = null
      emit('SIGNED_OUT', null)
      return { error: null }
    }),
    resetPasswordForEmail: vi.fn(async () => ({
      data: {},
      error: null as unknown,
    })),
    exchangeCodeForSession: vi.fn(async () => ({
      data: {},
      error: null as unknown,
    })),
    updateUser: vi.fn(async () => ({ data: {}, error: null as unknown })),
  }

  return {
    auth,
    /** Test controls */
    setSession(email: string | null) {
      session = email ? makeSession(email) : null
    },
    emit,
    get session() {
      return session
    },
    reset() {
      session = null
      listeners.clear()
      Object.values(auth).forEach((fn) => fn.mockClear())
    },
  }
}

function makeSession(email: string): FakeSession {
  return {
    access_token: 'test-access-token',
    user: { id: '11111111-1111-1111-1111-111111111111', email },
  }
}

export const fake = createFakeSupabase()

export function authError(over: Partial<{ status: number; code: string; name: string }>) {
  return Object.assign(new Error('auth failed'), { name: 'AuthApiError', ...over })
}
