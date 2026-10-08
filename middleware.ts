import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * The login gate. Every page and every API route (including /api/dashboard,
 * which carries the Instantly numbers) requires a Supabase session whose email
 * matches ALLOWED_USER_EMAIL. Anything unexpected -- missing env, auth outage,
 * wrong account -- denies access. It never widens it.
 */

// Read ALLOWED_USER_EMAIL per request rather than capturing it at module scope:
// a module-scope read freezes whatever the env held at import, which makes the
// gate impossible to test and hides a misconfigured deploy behind a value
// nobody can inspect. The placeholder is a fail-closed default so an unset env
// var can never widen access.
function allowedEmail(): string {
  return process.env.ALLOWED_USER_EMAIL || 'unset@invalid.local'
}

/**
 * Local-development escape hatch: DASHBOARD_DEV_NO_AUTH=1 skips the login so
 * the dashboard can be run and screenshotted without a Supabase project.
 *
 * It is honoured ONLY outside production. `process.env.NODE_ENV` is written as
 * a literal so Next inlines it at build time: in a production build (which is
 * what Vercel runs, for previews too) this function compiles to `false` and the
 * variable is never read. The Vercel check is a second, runtime lock.
 */
export function devAuthBypassEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.VERCEL) return false
  return process.env.DASHBOARD_DEV_NO_AUTH === '1'
}

function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/api/auth/')
}

/**
 * Validate the signed-in session from the request cookies.
 *
 * Returns null on any failure rather than throwing: auth trouble must redirect
 * to /login, never surface as a 500. Never returns a session when Supabase is
 * not configured, so a missing env var can't be mistaken for a valid login.
 *
 * Supabase may refresh the access token while validating it. The refreshed
 * cookies are written onto `response` (the standard @supabase/ssr middleware
 * pattern); before, they were only written onto the incoming request and then
 * dropped, so the browser kept a stale token and was eventually logged out.
 */
async function getSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  let response = NextResponse.next({ request })
  if (!url || !anonKey) return { user: null, response }

  // Auth verification does NOT need the service-role key -- that key bypasses
  // RLS and must not be required just to read a session cookie. The anon key
  // validates the JWT against Supabase Auth.
  const { createServerClient } = await import('@supabase/ssr')
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        )
      },
    },
  })
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { user: null, response }
  return { user: data.user, response }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isApi = pathname.startsWith('/api/')

  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  if (devAuthBypassEnabled()) {
    const response = NextResponse.next()
    response.headers.set('x-dashboard-auth', 'dev-bypass')
    return response
  }

  let user: { email?: string | null } | null = null
  let response: NextResponse | null = null
  try {
    const session = await getSession(request)
    user = session.user
    response = session.response
  } catch {
    user = null
  }

  // No session: redirect pages, 401 APIs. Nothing else leaves the request.
  if (!user || !response) {
    if (isApi) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Signed in, but is it the allowed account?
  const userEmail = user.email?.toLowerCase()
  if (!userEmail || userEmail !== allowedEmail().toLowerCase()) {
    if (isApi) {
      return NextResponse.json(
        { error: 'Forbidden: Account not authorized' },
        { status: 403 },
      )
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('error', 'unauthorized_account')
    return NextResponse.redirect(loginUrl)
  }

  // Authorized: continue, carrying any refreshed session cookies.
  return response
}

export const config = {
  matcher: [
    /*
     * Every request path except Next's own static assets and the favicon.
     * API routes are included on purpose: /api/dashboard is gated like a page.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
