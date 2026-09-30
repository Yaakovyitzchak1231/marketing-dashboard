import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'

/**
 * Request-scoped Supabase client that carries the caller's own session.
 *
 * Two rules, and both exist because of `supabase/migrations/002_enable_rls.sql`:
 *
 *  1. NEVER the service-role key. It bypasses RLS by design, so a read path
 *     that uses it would be an unauthenticated read of every row wearing a
 *     costume -- the exact defect RLS was enabled to close.
 *
 *  2. The session MUST reach PostgREST. RLS grants SELECT to `authenticated`
 *     only, and PostgREST decides which role you are from the token on the
 *     request. A client built from the anon key with no user token is the `anon`
 *     role, which no policy matches, so every query returns `[]` -- HTTP 200
 *     with no rows. That is the dangerous shape: a dashboard that renders an
 *     honest-looking empty state while the data sits unread in the database.
 *
 * The token is taken from the Authorization header when present, and otherwise
 * from the session cookie the middleware already validated. A browser request
 * to the page carries only the cookie; a server-side call carries the header.
 *
 * Returns null when Supabase is not configured, so the caller can answer 503
 * rather than pretending the account sent nothing.
 */
export async function getRequestClient(
  request: NextRequest,
): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  // Preferred path: an explicit bearer token.
  const header = request.headers.get('authorization') || ''
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null
  if (headerToken) {
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${headerToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  // Fallback: read the session out of the request cookies with the same
  // @supabase/ssr cookie jar the middleware uses, so the token the user
  // actually signed in with is the token the data query runs as.
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll() {
        // A read-only request cannot refresh the session; the middleware and
        // the browser client own writes. A no-op here is correct, not a gap.
      },
    },
  })

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) return null

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * A client that can read nothing.
 *
 * Used when no session could be resolved. It is deliberately NOT a client
 * built from the anon key: with RLS on, that returns `[]` with HTTP 200 and the
 * page renders "no data" when the truth is "not authorised". The routes pair
 * this with a 401 so the failure is visible instead of looking like an empty
 * account.
 */
export function unauthorizedClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    global: { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
