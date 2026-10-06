/** Public, browser-safe configuration only. Secrets never belong here. */
export const env = {
  apiUrl: (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, ''),
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  publicAppUrl: (import.meta.env.VITE_PUBLIC_APP_URL ?? '').replace(/\/$/, ''),
}
