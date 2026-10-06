/**
 * Single place that knows the URL scheme. The app uses hash routing (docs/adr/0002), so a
 * customer link looks like `https://app.example.com/#/pay/<token>`. Moving to path URLs later
 * means changing the router + `buildPayUrl` only; payment architecture is unaffected.
 */
export const routes = {
  dashboard: '/',
  collections: '/collections',
  collection: (id: string) => `/collections/${id}`,
  upload: '/upload',
  settings: '/settings',
  pay: (token: string) => `/pay/${token}`,
} as const

/** Full public payment URL for a token. `publicAppUrl` is a public value (no secrets). */
export function buildPayUrl(publicAppUrl: string, token: string): string {
  return `${publicAppUrl.replace(/\/$/, '')}/#${routes.pay(encodeURIComponent(token))}`
}
