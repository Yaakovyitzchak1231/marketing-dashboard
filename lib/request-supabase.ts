import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'

/**
 * A request-scoped Supabase client that carries the caller's session.
 *
 * Two sources of the session, in priority order:
 *
 *   1. `Authorization: Bearer <token>` -- a direct API call from a client
 *      that already holds a token.
 *   2. The `@supabase/ssr` cookie jar -- how the server-rendered shell
 *      actually reaches these routes.
 *
 * Source 2 is the one that was missing, and its absence is why this dashboard
 * rendered empty against a fully populated database. `app/page.tsx` is a
 * Server Component: `lib/load-shell-data.ts` self-fetches `/api/overview` and
 * `/api/campaigns` and forwards the caller's **cookie**. Every route, however,
 * only ever looked at the `Authorization` **header**. So the self-fetch
 * arrived with no header, built a client with the anon key and no token, and
 * PostgREST applied RLS to an anonymous role -- which returns `[]`, not an
 * error. An empty result and "the account genuinely sent nothing" are
 * indistinguishable to the page, so it rendered the honest-looking empty state
 * over real data.
 *
 * The anon key is used deliberately and the service-role key never is: a
 * service-role read would bypass RLS entirely, which is the opposite of what a
 * private dashboard should do. Reading as the signed-in user is the point.
 */
export async function getRequestSupabaseClient(
  request: NextRequest,
): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  const header = request.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null
  if (bearer) {
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  // No header: the caller is the server-rendered shell replaying cookies.
  // Read the session out of the same jar @supabase/ssr writes, so the query
  // runs as the real signed-in user instead of as anon.
  const { createServerClient } = await import('@supabase/ssr')
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
      },
    },
  })
}
