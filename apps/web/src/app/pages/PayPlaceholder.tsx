import { useParams } from 'react-router'

/**
 * Public route stub for `/#/pay/:token`. Phase 0 intentionally does NOT read the token, call the
 * API, or show any payment behaviour (Phase 4). Standalone layout: no employer navigation.
 */
export function PayPlaceholderPage() {
  useParams() // route exists; token deliberately unused
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-2 px-4 text-center">
      <h1 className="text-xl font-semibold">Payment page</h1>
      <p className="text-ink-2">This page is not available yet.</p>
    </main>
  )
}
