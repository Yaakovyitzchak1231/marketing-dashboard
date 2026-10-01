import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The auth gate.
 *
 * `middleware.ts` does NOT use a module-level Supabase client. It builds a
 * request-scoped one with `@supabase/ssr` inside the handler, because a plain
 * `@supabase/supabase-js` client cannot read the request cookies -- which is
 * why signing in succeeded while every protected route redirected to /login
 * forever. The previous version of this test mocked `@/lib/supabase-server`,
 * a module the middleware no longer imports, so every "authenticated" case
 * actually ran unauthenticated and failed.
 *
 * These tests therefore mock `@supabase/ssr`'s `createServerClient`, which is
 * the seam the middleware actually goes through, and assert the real
 * behaviour: session -> allow-list -> pass, no session -> redirect, wrong
 * user -> 403/redirect.
 */

const mockSsrClient = vi.hoisted(() => ({
  auth: {
    getUser: vi.fn(),
    getSession: vi.fn(),
    signOut: vi.fn(),
  },
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => mockSsrClient),
}))

import { middleware } from '@/middleware'

const ALLOWED = 'jacob@example.com'

/** A resolved session for `email`, or no session at all when email is null. */
function sessionFor(email: string | null) {
  if (email === null) {
    mockSsrClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Auth session missing' },
    })
    return
  }
  mockSsrClient.auth.getUser.mockResolvedValue({
    data: { user: { email } },
    error: null,
  })
}

function req(path: string) {
  return new NextRequest(new URL(path, 'http://localhost'))
}

/**
 * The middleware refuses to validate a session at all unless Supabase is
 * configured -- deliberately, so a missing env var can never be mistaken for a
 * valid session. These tests exercise the auth decision rather than that
 * configuration guard, so they supply the two public values it looks for.
 * They are dummies: the client is mocked and no request leaves the process.
 */
function withSupabaseEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key'
}

beforeEach(() => {
  vi.clearAllMocks()
  withSupabaseEnv()
})

describe('Auth Gate - public paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ALLOWED_USER_EMAIL = ALLOWED
  })

  it('allows /login without a session', async () => {
    sessionFor(null)
    const response = await middleware(req('/login'))
    expect(response.status).toBe(200)
  })

  it('allows the auth routes without a session', async () => {
    sessionFor(null)
    const response = await middleware(req('/api/auth/logout'))
    expect(response.status).toBe(200)
  })
})

describe('Auth Gate - no session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ALLOWED_USER_EMAIL = ALLOWED
  })

  it('redirects a page request to /login', async () => {
    sessionFor(null)
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('returns 401 for an API request and leaks nothing', async () => {
    sessionFor(null)
    const response = await middleware(req('/api/overview'))
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
    // The only key allowed out of a rejected request is the error itself.
    expect(Object.keys(body)).toEqual(['error'])
  })
})

describe('Auth Gate - session present', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ALLOWED_USER_EMAIL = ALLOWED
  })

  it('passes an allow-listed user', async () => {
    sessionFor(ALLOWED)
    const response = await middleware(req('/'))
    expect(response.status).toBe(200)
  })

  it('matches the allow-list case-insensitively', async () => {
    sessionFor('Jacob@Example.com')
    const response = await middleware(req('/'))
    expect(response.status).toBe(200)
  })

  it('rejects an authenticated non-allow-listed user', async () => {
    sessionFor('other@example.com')
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain(
      '/login?error=unauthorized_account',
    )
  })

  it('returns 403 for a non-allow-listed user on API routes', async () => {
    sessionFor('other@example.com')
    const response = await middleware(req('/api/overview'))
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('Forbidden: Account not authorized')
  })
})

describe('Auth Gate - fail closed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * The most important test in this file.
   *
   * An unset allow-list must authorise nobody. If it ever widened access, the
   * dashboard would show a business's campaign data to any Supabase user in
   * the project, and every "no fabricated numbers" guarantee in the repo would
   * be moot -- the numbers would be real but shown to the wrong person.
   */
  it('authorises nobody when ALLOWED_USER_EMAIL is unset', async () => {
    delete process.env.ALLOWED_USER_EMAIL
    sessionFor('anyone@example.com')
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain(
      '/login?error=unauthorized_account',
    )
  })

  /**
   * Supabase throwing must fail closed too. An auth outage has to deny access,
   * not wave everyone through.
   */
  it('denies access when the auth client throws', async () => {
    process.env.ALLOWED_USER_EMAIL = ALLOWED
    mockSsrClient.auth.getUser.mockRejectedValue(new Error('auth down'))
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('does not require the service-role key to validate a session', async () => {
    process.env.ALLOWED_USER_EMAIL = ALLOWED
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    sessionFor(ALLOWED)
    const response = await middleware(req('/'))
    expect(response.status).toBe(200)
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey
  })
})

describe('Auth Gate - client bundle safety', () => {
  it('service role key is never exposed in NEXT_PUBLIC_* env vars', () => {
    const publicEnvKeys = Object.keys(process.env).filter((k) =>
      k.startsWith('NEXT_PUBLIC_'),
    )
    expect(publicEnvKeys).not.toContain(
      'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
    )
    expect(publicEnvKeys).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})