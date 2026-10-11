import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isFallbackOwner } from '@/lib/auth/roles'

/**
 * The login gate. Every page and every API route (including /api/dashboard,
 * which carries the Instantly numbers) requires a Supabase session that
 * resolves to a role (lib/auth/roles.ts): either the permanent
 * ALLOWED_USER_EMAIL owner fallback (checked right here, no I/O), or an
 * active lp.actors human row (plan 1.14 -- Users & roles), checked by asking
 * /api/internal/role -- this middleware runs on the Edge runtime and cannot
 * open a plain Postgres connection itself (lib/db uses `pg`, which needs
 * Node's net/tls; that route runs on the normal Node runtime and can).
 * Anything unexpected -- missing env, auth outage, wrong or unknown account,
 * that internal call failing -- denies access. It never widens it.
 */

function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/api/auth/')
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

/**
 * Machine routes that authenticate themselves instead of using the login:
 *  - /api/ops/*           agents, each with its own bearer token (OPS_AGENT_TOKENS)
 *  - /api/webhooks/*      Instantly, with a shared secret (INSTANTLY_WEBHOOK_SECRET)
 *  - /api/internal/role   middleware's own role lookup; it re-derives the
 *                         caller's session from cookies itself and answers
 *                         { role: null } for anyone without one, so exempting
 *                         it from this gate does not widen anything.
 * Each route rejects any request without its credential (fail closed).
 */
export function isSelfAuthenticatingApi(pathname: string): boolean {
  return (
    pathname === '/api/ops' ||
    pathname.startsWith('/api/ops/') ||
    pathname.startsWith('/api/webhooks/') ||
    pathname === '/api/internal/role'
  )
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

/**
 * The non-fallback path: ask /api/internal/role, forwarding this request's
 * own cookies so that route can re-derive the same session independently
 * (never trusting an email passed across the hop). Any failure (network,
 * non-200, bad body) resolves to null -- fail closed.
 */
async function resolveRoleViaInternalApi(request: NextRequest): Promise<string | null> {
  try {
    const res = await fetch(new URL('/api/internal/role', request.url), {
      headers: { cookie: request.headers.get('cookie') ?? '' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { role?: string | null }
    return body.role ?? null
  } catch {
    return null
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isApi = pathname.startsWith('/api/')

  if (isPublicPath(pathname) || isSelfAuthenticatingApi(pathname)) {
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

  // Signed in, but does the account resolve to a role? The env fallback is
  // checked first and needs no network call, so Yaakov's own login never
  // depends on the database (or this Edge function reaching it) at all.
  const userEmail = user.email?.toLowerCase() ?? null
  const role = isFallbackOwner(userEmail) ? 'owner' : await resolveRoleViaInternalApi(request)
  if (!role) {
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

  // Viewers are read-only (plan 1.14): block every mutation centrally, here,
  // rather than trusting each server action / API route to check for itself.
  // Two independent signals catch a write, fail-closed:
  //  - any non-GET/HEAD request to /api/* (the self-authenticating machine
  //    routes already returned above and never reach this point);
  //  - any request carrying Next's `next-action` header, which marks an
  //    invocation of a server action on a page route (the write paths behind
  //    forms like Settings and Team never go through /api/* at all).
  // A 403 here is also the right response for a server action: the client
  // runtime surfaces the thrown error text, it does not need a redirect.
  if (role === 'viewer' && isMutatingRequest(request, pathname, isApi)) {
    return NextResponse.json(
      { error: 'Viewers can look but not change things' },
      { status: 403 },
    )
  }

  // Authorized: continue, carrying any refreshed session cookies.
  return response
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

/**
 * True for any request a viewer must not be allowed to make: a non-GET/HEAD
 * call to /api/* (leads, rules, verify, find, research, campaign-steps,
 * suppressions and anything else under /api -- this check is central so a
 * new write route needs no opt-in), or any request carrying the `next-action`
 * header Next.js attaches to a server-action invocation, wherever it lands.
 */
function isMutatingRequest(request: NextRequest, pathname: string, isApi: boolean): boolean {
  const method = request.method.toUpperCase()
  if (isApi && !SAFE_METHODS.has(method)) return true
  if (request.headers.has('next-action')) return true
  return false
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
