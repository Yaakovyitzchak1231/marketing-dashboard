import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/ops/* (agents, bearer token) and /api/webhooks/* (Instantly, shared
 * secret) authenticate inside the route, so the login gate lets them through.
 * Everything else, including the new lead routes, still needs the login.
 */
const client = vi.hoisted(() => ({ auth: { getUser: vi.fn() } }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => client) }))

import { middleware, isSelfAuthenticatingApi } from '@/middleware'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon')
  vi.stubEnv('ALLOWED_USER_EMAIL', 'owner@example.com')
  vi.stubEnv('DASHBOARD_DEV_NO_AUTH', '')
  client.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
})

const req = (p: string) => new NextRequest(new URL(p, 'http://localhost'))

describe('machine routes skip the login gate (and only those)', () => {
  it('classifies paths', () => {
    expect(isSelfAuthenticatingApi('/api/ops')).toBe(true)
    expect(isSelfAuthenticatingApi('/api/ops/tasks/claim')).toBe(true)
    expect(isSelfAuthenticatingApi('/api/webhooks/instantly')).toBe(true)
    expect(isSelfAuthenticatingApi('/api/opsx')).toBe(false)
    expect(isSelfAuthenticatingApi('/api/leads/stage')).toBe(false)
    expect(isSelfAuthenticatingApi('/api/verify/preview')).toBe(false)
  })
  it('passes /api/ops and /api/webhooks through without a session', async () => {
    expect((await middleware(req('/api/ops/tasks/claim'))).status).toBe(200)
    expect((await middleware(req('/api/webhooks/instantly'))).status).toBe(200)
  })
  it('still refuses the lead, verify and team routes and pages without a session', async () => {
    expect((await middleware(req('/api/leads/stage'))).status).toBe(401)
    expect((await middleware(req('/api/verify/runs/1/approve'))).status).toBe(401)
    expect((await middleware(req('/api/find/jobs'))).status).toBe(401)
    const page = await middleware(req('/team'))
    expect(page.status).toBe(307)
    expect(page.headers.get('location')).toContain('/login')
  })
})
