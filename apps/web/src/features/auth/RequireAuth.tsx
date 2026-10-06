import { Navigate, Outlet, useLocation } from 'react-router'
import { Alert, Card, Skeleton } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { SessionExpiredModal } from '@/features/auth/SessionExpiredModal'
import { routes } from '@/lib/routes'

/** Guards every employer screen. The login routes live OUTSIDE this guard, so no redirect loops. */
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <main className="grid min-h-dvh place-items-center p-4" aria-busy="true">
        <div role="status" className="w-full max-w-sm">
          <span className="sr-only">Loading…</span>
          <Skeleton className="mb-3 h-8 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      </main>
    )
  }
  if (status === 'unconfigured') {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <Card className="max-w-md">
          <Alert tone="warning" title="Sign-in isn't configured">
            Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this build.
          </Alert>
        </Card>
      </main>
    )
  }
  if (status === 'signed-out') {
    const next = `${location.pathname}${location.search}`
    const to = next === '/' ? routes.login : `${routes.login}?next=${encodeURIComponent(next)}`
    return <Navigate to={to} replace />
  }
  // signed-in, or expired: keep the screen (and any unsaved form state) and overlay the modal.
  return (
    <>
      <Outlet />
      <SessionExpiredModal open={status === 'expired'} />
    </>
  )
}
