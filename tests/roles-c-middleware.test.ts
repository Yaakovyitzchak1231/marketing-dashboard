import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// Viktor's #78/#87 review (High): a Viewer could get past the middleware
// write-gate with a plain no-JS form POST. Next runs a server action from a
// multipart or urlencoded POST to a PAGE route carrying a $ACTION_ID_... field,
// with no `next-action` header -- and the gate only looked at that header (or
// at /api/*). Every older action with no role check of its own (campaigns,
// edit, suppressions, reports, rules, jobs, seo, ops, comments, approvals,
// connect, integrations, agents) was then open to a Viewer.
vi.mock('server-only', () => ({}))

const mockSsrClient = vi.hoisted(() => ({ auth: { getUser: vi.fn() } }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => mockSsrClient) }))

import { middleware, isMutatingRequest } from '@/middleware'

function signedInAs(email: string, role: string) {
  mockSsrClient.auth.getUser.mockResolvedValue({ data: { user: { email } }, error: null })
  vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ role }) } as Response)
}

function multipartActionPost(path: string) {
  const fd = new FormData()
  fd.set('$ACTION_ID_0123456789abcdef', '')
  fd.set('campaign_id', '7')
  return new NextRequest(new URL(path, 'http://localhost'), { method: 'POST', body: fd })
}

function urlencodedActionPost(path: string) {
  return new NextRequest(new URL(path, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '%24ACTION_ID_0123456789abcdef=&campaign_id=7',
  })
}

describe('viewer write-gate covers no-JS form posts to page routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key'
    process.env.ALLOWED_USER_EMAIL = 'owner@example.com'
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses a viewer multipart form POST to a page (no next-action header)', async () => {
    signedInAs('viewer@example.com', 'viewer')
    const r = multipartActionPost('/campaigns/7')
    expect(r.headers.has('next-action')).toBe(false)
    const res = await middleware(r)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Viewers can look but not change things')
  })

  it('refuses a viewer urlencoded form POST to a page', async () => {
    signedInAs('viewer@example.com', 'viewer')
    const res = await middleware(urlencodedActionPost('/agents/tab'))
    expect(res.status).toBe(403)
  })

  it('refuses a viewer PUT / PATCH / DELETE on a page route too', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      signedInAs('viewer@example.com', 'viewer')
      const res = await middleware(new NextRequest(new URL('/settings', 'http://localhost'), { method }))
      expect(res.status).toBe(403)
    }
  })

  it('still lets a viewer read pages (GET and HEAD)', async () => {
    signedInAs('viewer@example.com', 'viewer')
    expect((await middleware(new NextRequest(new URL('/campaigns/7', 'http://localhost')))).status).toBe(200)
    signedInAs('viewer@example.com', 'viewer')
    expect((await middleware(new NextRequest(new URL('/settings/users', 'http://localhost'), { method: 'HEAD' }))).status).toBe(200)
  })

  it('lets an editor and the owner submit the same form', async () => {
    signedInAs('editor@example.com', 'editor')
    expect((await middleware(multipartActionPost('/campaigns/7'))).status).toBe(200)
    vi.restoreAllMocks()
    mockSsrClient.auth.getUser.mockResolvedValue({ data: { user: { email: 'owner@example.com' } }, error: null })
    expect((await middleware(urlencodedActionPost('/campaigns/7'))).status).toBe(200)
  })

  it('isMutatingRequest: every non-GET/HEAD method on any path, or the next-action header', () => {
    const r = (path: string, method = 'GET', headers?: Record<string, string>) => new NextRequest(new URL(path, 'http://localhost'), { method, headers })
    expect(isMutatingRequest(r('/campaigns', 'POST'))).toBe(true)
    expect(isMutatingRequest(r('/api/leads/stage', 'POST'))).toBe(true)
    expect(isMutatingRequest(r('/settings', 'GET', { 'next-action': 'x' }))).toBe(true)
    expect(isMutatingRequest(r('/settings', 'GET'))).toBe(false)
    expect(isMutatingRequest(r('/settings', 'HEAD'))).toBe(false)
  })
})
