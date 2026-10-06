import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Supabase is used ONLY for authentication (login / refresh / reset). All data goes through our API.
 * PKCE keeps auth codes in the query string, which does not collide with hash routing (ADR 0002).
 * Only the public anon key is available here; service-role keys are backend-only.
 */
export const supabase: SupabaseClient | null =
  env.supabaseUrl && env.supabaseAnonKey
    ? createClient(env.supabaseUrl, env.supabaseAnonKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true },
      })
    : null
