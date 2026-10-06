import { useQuery } from '@tanstack/react-query'
import { Alert, Card, Skeleton } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { api } from '@/lib/api'
import { env } from '@/lib/env'

const AUTH_TEXT = {
  loading: 'Checking…',
  unconfigured: 'Not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)',
  'signed-out': 'Not signed in',
  'signed-in': 'Signed in',
  expired: 'Session expired',
} as const

/** Phase 0 diagnostics: proves frontend -> backend connectivity and auth wiring. Removed/replaced later. */
export function ConnectionStatus() {
  const auth = useAuth()
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const { data, error } = await api.GET('/healthz')
      if (error || !data) throw new Error('health check failed')
      return data
    },
    retry: false,
  })

  return (
    <Card aria-labelledby="diag-title">
      <h2 id="diag-title" className="text-lg font-semibold">
        System status
      </h2>
      <p className="text-sm text-ink-2">Foundation diagnostics (Phase 0)</p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-ink-2">Backend API</dt>
          <dd>
            {health.isPending ? (
              <Skeleton className="mt-1 h-6 w-40" />
            ) : health.isError ? (
              <Alert tone="error" title="API unreachable">
                Could not reach {env.apiUrl}. Is the backend running?
              </Alert>
            ) : (
              <span className="font-medium text-success">API reachable ({health.data.status})</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-ink-2">Authentication</dt>
          <dd className="font-medium">{AUTH_TEXT[auth.status]}</dd>
        </div>
      </dl>
    </Card>
  )
}
