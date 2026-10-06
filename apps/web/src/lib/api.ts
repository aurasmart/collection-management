import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from '@collections/api-types'
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
}

// Resolve fetch lazily so tests (and polyfills) can replace globalThis.fetch.
export const api = createClient<paths>({
  baseUrl: env.apiUrl,
  fetch: (request) => globalThis.fetch(request),
})
api.use(auth)
