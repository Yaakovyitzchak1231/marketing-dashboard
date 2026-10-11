import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// See tests/auth-gate.test.ts: middleware.ts now reaches lib/auth/roles, which is 'server-only'.
vi.mock('server-only', () => ({}))

/**
 * DASHBOARD_DEV_NO_AUTH=1 lets a developer run the dashboard locally without a
 * Supabase project. These tests prove it can never open the gate in production
 * (or on any Vercel deployment), where the normal login check must still run.
 */

const mockSsrClient = vi.hoisted(() => ({
  auth: { getUser: vi.fn() },
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => mockSsrClient),
}))

import { middleware, devAuthBypassEnabled } from '@/middleware'

function req(path: string) {
  return new NextRequest(new URL(path, 'http://localhost'))
}

function noSession() {
  mockSsrClient.auth.getUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Auth session missing' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  vi.stubEnv('ALLOWED_USER_EMAIL', 'jacob@example.com')
  noSession()
})

describe('dev auth bypass - development', () => {
  it('lets a page through with no session when DASHBOARD_DEV_NO_AUTH=1', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    expect(devAuthBypassEnabled()).toBe(true)
    const response = await middleware(req('/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-dashboard-auth')).toBe('dev-bypass')
    expect(mockSsrClient.auth.getUser).not.toHaveBeenCalled()
  })

  it('lets /api/dashboard through with no session when DASHBOARD_DEV_NO_AUTH=1', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    const response = await middleware(req('/api/dashboard'))
    expect(response.status).toBe(200)
  })

  it('only accepts the exact value "1"', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      vi.stubEnv('DASHBOARD_DEV_NO_AUTH', value)
      expect(devAuthBypassEnabled()).toBe(false)
      const response = await middleware(req('/'))
      expect(response.status).toBe(307)
    }
  })

  it('is off by default in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '')
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })
})

describe('dev auth bypass - production ignores it', () => {
  it('still redirects a page to /login in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    expect(devAuthBypassEnabled()).toBe(false)
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
    expect(response.headers.get('x-dashboard-auth')).toBeNull()
  })

  it('still returns 401 for /api/dashboard in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    const response = await middleware(req('/api/dashboard'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('still enforces the allow-list in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    mockSsrClient.auth.getUser.mockResolvedValue({
      data: { user: { email: 'someone-else@example.com' } },
      error: null,
    })
    const response = await middleware(req('/api/dashboard'))
    expect(response.status).toBe(403)
  })

  it('is ignored on any Vercel deployment even if NODE_ENV were not production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '1')
    expect(devAuthBypassEnabled()).toBe(false)
    const response = await middleware(req('/'))
    expect(response.status).toBe(307)
  })

  it('is off under the test runner unless the flag is set', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '')
    expect(devAuthBypassEnabled()).toBe(false)
  })
})
