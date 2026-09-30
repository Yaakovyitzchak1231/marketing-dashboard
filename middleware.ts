import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

const ALLOWED_EMAIL = process.env.ALLOWED_USER_EMAIL || 'jacob@example.com'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Public paths - no auth required
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next()
  }

  // Create server client
  const supabase = createServerSupabaseClient()
  
  // Get session
  const { data: { session }, error } = await supabase.auth.getSession()

  // No session - redirect pages, 401 APIs
  if (!session || error) {
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
    // Sign out the unauthorized user
    await supabase.auth.signOut()
    
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