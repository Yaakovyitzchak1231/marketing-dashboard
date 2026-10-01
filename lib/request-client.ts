import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Request-scoped Supabase client carrying the caller's session.
 *
 * Uses the anon key (never the service-role key) plus the caller's session
 * from cookies (via @supabase/ssr) or a Bearer token, so PostgREST enforces
 * row-level security against the real signed-in user. Returns null when
 * Supabase is not configured or the caller sent no session.
 */
export async function getRequestClient(request: NextRequest): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  // Prefer an explicit Bearer token when the caller sends one.
  const header = request.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null

  if (bearer) {
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  // Fall back to the session cookie (server components forward cookies).
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {},
    },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
