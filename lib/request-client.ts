import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Request-scoped Supabase client carrying the caller's session.
 *
 * Uses the anon key (never the service-role key) plus the caller's access
 * token, so PostgREST enforces row-level security against the real signed-in
 * user. Returns null when Supabase is not configured or the caller sent no
 * token.
 */
export function getRequestClient(request: NextRequest): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  const header = request.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  return createClient(url, anonKey, {
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
