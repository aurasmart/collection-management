import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from '@collections/api-types'
import { authEvents } from '@/lib/auth-events'
import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'

/** Adds the user's access token (if any). The employer id is NEVER sent: the server derives it. */
const auth: Middleware = {
  async onRequest({ request }) {
    const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } }
    const token = data.session?.access_token
    if (token) request.headers.set('Authorization', `Bearer ${token}`)
    return request
  },
  async onResponse({ response }) {
    // A 401 on a request that carried a token means the session is no longer valid (Stage 2 S12).
    if (response.status === 401 && response.url && !response.url.includes('/healthz')) {
      authEvents.emitUnauthorized()
    }
    return response
  },
}

// Resolve fetch lazily so tests (and polyfills) can replace globalThis.fetch.
export const api = createClient<paths>({
  baseUrl: env.apiUrl,
  fetch: (request) => globalThis.fetch(request),
})
api.use(auth)

export interface ApiFieldError {
  field: string
  message: string
}

/** FastAPI/Pydantic 422 body -> per-field messages (loc = ["body", "<field>"]). */
export function fieldErrors(error: unknown): ApiFieldError[] {
  const detail = (error as { detail?: unknown } | undefined)?.detail
  if (!Array.isArray(detail)) return []
  return detail.flatMap((d: unknown) => {
    const e = d as { loc?: unknown[]; msg?: string }
    const field = e.loc?.at(-1)
    return typeof field === 'string' && e.msg
      ? [{ field, message: e.msg.replace(/^Value error, /, '') }]
      : []
  })
}

/** `{ detail: { code: "reauth_required" } }` from a 403. */
export function isReauthRequired(error: unknown): boolean {
  const detail = (error as { detail?: { code?: string } } | undefined)?.detail
  return typeof detail === 'object' && detail?.code === 'reauth_required'
}
