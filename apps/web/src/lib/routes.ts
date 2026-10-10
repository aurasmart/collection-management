/**
 * Single place that knows the URL scheme. The app uses hash routing (docs/adr/0002), so a
 * customer link looks like `https://app.example.com/#/pay/<token>`. Moving to path URLs later
 * means changing the router + `buildPayUrl` only; payment architecture is unaffected.
 */
export const routes = {
  dashboard: '/',
  collections: '/collections',
  pettyCash: '/petty-cash',
  collection: (id: string) => `/collections/${id}`,
  upload: '/upload',
  settings: '/settings',
  settingsCompany: '/settings/company',
  settingsPayment: '/settings/payment',
  settingsAccount: '/settings/account',
  settingsSecurity: '/settings/security',
  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  pay: (token: string) => `/pay/${token}`,
} as const

/** Full public payment URL for a token. `publicAppUrl` is a public value (no secrets). */
export function buildPayUrl(publicAppUrl: string, token: string): string {
  return `${publicAppUrl.replace(/\/$/, '')}/#${routes.pay(encodeURIComponent(token))}`
}

/** The link a customer opens. `publicAppUrl` is the public site address (no secrets). */
export function paymentPageLink(token: string): string {
  const base =
    import.meta.env.VITE_PUBLIC_APP_URL ||
    `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/$/, '')
  return buildPayUrl(base, token)
}

/** Absolute address of an app screen (used in e-mail links). Public value, no secrets. */
export function appUrl(path: string): string {
  const base =
    import.meta.env.VITE_PUBLIC_APP_URL ||
    `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/$/, '')
  return `${base.replace(/\/$/, '')}/#${path}`
}
