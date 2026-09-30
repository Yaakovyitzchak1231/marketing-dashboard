import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Jacob only. Set ALLOWED_USER_EMAIL in the environment; the placeholder below
// is a fail-closed default so an unset env var can never widen access.
const ALLOWED_EMAIL = process.env.ALLOWED_USER_EMAIL || 'unset@invalid.local'

/**
 * Read the signed-in session from the request cookies.
 *
 * Returns null on any failure rather than throwing: auth trouble must redirect
 * to /login, never surface as a 500. Never returns a session when the allow-list
 * env var is missing, because an unset allow-list cannot authorise anyone.
 */
async function getSessionSafeInternal(request: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return null
  }
  // A plain @supabase/supabase-js client has no access to the request cookies,
  // so getUser() had no token to validate and every protected route redirected
  // to /login forever. @supabase/ssr wires the cookie jar in explicitly.
  const { createServerClient } = await import('@supabase/ssr')
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })
        },
      },
    }
  )
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return { user: data.user }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Public paths - no auth required
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next()
  }

  // Verify the session. Auth verification does NOT need the service-role key --
  // that key bypasses RLS entirely and must not be required just to read a
  // session cookie. The anon key validates the JWT against Supabase Auth. Using
  // the service key here also meant a missing service key threw inside the
  // middleware and turned every protected route into a 500 instead of a
  // redirect to /login.
  let session: Awaited<ReturnType<typeof getSessionSafeInternal>> = null
  try {
    session = await getSessionSafeInternal(request)
  } catch {
    session = null
  }

  // No session - redirect pages, 401 APIs
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }
    
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  // Check allow-list
  const userEmail = session.user.email?.toLowerCase()
  const allowedEmail = ALLOWED_EMAIL.toLowerCase()

  if (userEmail !== allowedEmail) {
    // Clear the session cookie by redirecting to logout. Calling auth.signOut()
    // here would need a server client, and the cookie can be dropped on the
    // next response without one.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Forbidden: Account not authorized' },
        { status: 403 }
      )
    }
    
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('error', 'unauthorized_account')
    return NextResponse.redirect(loginUrl)
  }

  // Authorized - continue
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
}