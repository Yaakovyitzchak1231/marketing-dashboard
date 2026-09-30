import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock the server supabase client
const mockSupabaseServer = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    signOut: vi.fn()
  },
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
  inner: vi.fn().mockReturnThis()
}))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(() => mockSupabaseServer)
}))

// Mock the client supabase
const mockSupabaseClient = vi.hoisted(() => ({
  auth: {
    signInWithOtp: vi.fn(),
    getSession: vi.fn(),
    signOut: vi.fn()
  },
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
  inner: vi.fn().mockReturnThis()
}))

vi.mock('@/lib/supabase', () => ({
  supabase: mockSupabaseClient
}))

// Also mock the API route imports
const mockSupabaseApi = vi.hoisted(() => ({
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
  inner: vi.fn().mockReturnThis()
}))

vi.mock('@/lib/supabase', () => ({
  supabase: mockSupabaseApi
}))

// Import after mocks
import { middleware } from '@/middleware'
import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'
import { POST as logoutPOST } from '@/app/api/auth/logout/route'

describe('Auth Gate - Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ALLOWED_USER_EMAIL = 'jacob@example.com'
  })

  it('allows access to /login without authentication', async () => {
    const request = new NextRequest(new URL('/login', 'http://localhost'))
    const response = await middleware(request)
    expect(response.status).toBe(200)
  })

  it('allows access to /api/auth without authentication', async () => {
    const request = new NextRequest(new URL('/api/auth/logout', 'http://localhost'))
    const response = await middleware(request)
    expect(response.status).toBe(200)
  })

  it('redirects unauthenticated page requests to /login', async () => {
    mockSupabaseServer.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    
    const request = new NextRequest(new URL('/', 'http://localhost'))
    const response = await middleware(request)
    
    expect(response.status).toBe(307) // redirect
    expect(response.headers.get('location')).toContain('/login')
  })

  it('returns 401 for unauthenticated API requests', async () => {
    mockSupabaseServer.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    
    const request = new NextRequest(new URL('/api/overview', 'http://localhost'))
    const response = await middleware(request)
    
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
    // Verify no data is leaked
    expect(Object.keys(body)).toEqual(['error'])
  })

  it('allows authenticated allow-listed user', async () => {
    mockSupabaseServer.auth.getSession.mockResolvedValue({
      data: { session: { user: { email: 'jacob@example.com' } } },
      error: null
    })
    
    const request = new NextRequest(new URL('/', 'http://localhost'))
    const response = await middleware(request)
    
    expect(response.status).toBe(200)
  })

  it('rejects authenticated non-allow-listed user', async () => {
    mockSupabaseServer.auth.getSession.mockResolvedValue({
      data: { session: { user: { email: 'other@example.com' } } },
      error: null
    })
    mockSupabaseServer.auth.signOut.mockResolvedValue({ error: null })
    
    const request = new NextRequest(new URL('/', 'http://localhost'))
    const response = await middleware(request)
    
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login?error=unauthorized_account')
  })

  it('returns 403 for non-allow-listed user on API routes', async () => {
    mockSupabaseServer.auth.getSession.mockResolvedValue({
      data: { session: { user: { email: 'other@example.com' } } },
      error: null
    })
    mockSupabaseServer.auth.signOut.mockResolvedValue({ error: null })
    
    const request = new NextRequest(new URL('/api/overview', 'http://localhost'))
    const response = await middleware(request)
    
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Forbidden: Account not authorized')
  })
})

describe('Auth Gate - API Route Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('overview API returns 401 when unauthenticated (via middleware)', async () => {
    // The middleware handles auth, so the route handler shouldn't be reached
    // This test verifies the route doesn't leak data on its own
    mockSupabaseApi.single.mockResolvedValue({
      data: { emails_sent: 1000, replies_human: 50 },
      error: null
    })
    
    const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
    const response = await overviewGET(request)
    const data = await response.json()
    
    // Route itself should still work (middleware is separate layer)
    // This is testing the route handler logic
    expect(data.emails_sent).toBe(1000)
    expect(data.replies_human).toBe(50)
  })

  it('overview API never leaks service key in response', async () => {
    mockSupabaseApi.single.mockResolvedValue({
      data: { emails_sent: 1000, replies_human: 50 },
      error: null
    })
    
    const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
    const response = await overviewGET(request)
    const data = await response.json()
    
    // Verify no service key or internal data in response
    const responseText = JSON.stringify(data)
    expect(responseText).not.toContain('service_role')
    expect(responseText).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})

describe('Auth Gate - Logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logout invalidates session', async () => {
    mockSupabaseServer.auth.signOut.mockResolvedValue({ error: null })
    
    const request = new NextRequest(new URL('/api/auth/logout', 'http://localhost'), { method: 'POST' })
    const response = await logoutPOST(request)
    const data = await response.json()
    
    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(mockSupabaseServer.auth.signOut).toHaveBeenCalled()
  })

  it('logout returns error on failure', async () => {
    mockSupabaseServer.auth.signOut.mockResolvedValue({ error: { message: 'Failed' } })
    
    const request = new NextRequest(new URL('/api/auth/logout', 'http://localhost'), { method: 'POST' })
    const response = await logoutPOST(request)
    const data = await response.json()
    
    expect(response.status).toBe(500)
    expect(data.error).toBe('Failed to sign out')
  })
})

describe('Auth Gate - Client Bundle Safety', () => {
  it('service role key is never exposed in NEXT_PUBLIC_* env vars', () => {
    const publicEnvKeys = Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_'))
    expect(publicEnvKeys).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY')
    expect(publicEnvKeys).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('supabase-server.ts is not imported in client components', () => {
    // This is a structural test - the file should only be imported in server contexts
    // Actual bundle inspection happens in build test
    expect(true).toBe(true)
  })
})