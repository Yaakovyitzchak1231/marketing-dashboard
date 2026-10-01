import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Sign the caller out.
 *
 * This route used to build a service-role client from `lib/supabase-server`.
 * That client is constructed from an env URL and key alone: it has no request
 * scope and therefore no access to the cookie jar. `auth.signOut()` on it
 * revokes the token server-side but never clears the caller's session cookie,
 * so the browser kept presenting a session and the next protected request went
 * straight back into the dashboard. "Log out" appeared to do nothing.
 *
 * `getRequestClient` is request-scoped and cookie-backed, so signOut() clears
 * the cookie the middleware actually reads. It also uses the anon key rather
 * than the service-role key: signing yourself out must not require a key that
 * bypasses row-level security.
 */
export async function POST(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase is not configured' },
      { status: 503 }
    )
  }

  const { error } = await supabase.auth.signOut()

  if (error) {
    return NextResponse.json(
      { error: 'Failed to sign out' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}