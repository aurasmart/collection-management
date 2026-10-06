import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Supabase is used ONLY for authentication (login / refresh / reset). All data goes through our API.
 * PKCE keeps auth codes in the query string, which does not collide with hash routing (ADR 0002 and
 * docs/adr/0005-password-reset-pkce-hash-router.md). Only the public anon key is available here;
 * service-role keys are backend-only.
 */
export const authOptions = {
  flowType: 'pkce',
  detectSessionInUrl: false, // the reset page exchanges the code explicitly
  persistSession: true,
  autoRefreshToken: true,
} as const satisfies NonNullable<SupabaseClientOptions<'public'>['auth']>

export function createSupabase(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, { auth: authOptions })
}

export const supabase: SupabaseClient | null =
  env.supabaseUrl && env.supabaseAnonKey
    ? createSupabase(env.supabaseUrl, env.supabaseAnonKey)
    : null
