import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('server-only', () => ({}))

const mockSsrClient = vi.hoisted(() => ({
  auth: { getUser: vi.fn(), getSession: vi.fn(), signOut: vi.fn() },
}))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => mockSsrClient) }))

import { middleware, config } from '@/middleware'
import { safeNextPath } from '@/lib/auth/next-path'
import nextConfig from '@/next.config'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key'
  process.env.ALLOWED_USER_EMAIL = 'jacob@example.com'
  mockSsrClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Auth session missing' } })
})

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost'))

describe('safeNextPath', () => {
  it('keeps same-origin, path-absolute values with their query', () => {
    expect(safeNextPath('/leads?x=1')).toBe('/leads?x=1')
    expect(safeNextPath('/campaigns/abc-123')).toBe('/campaigns/abc-123')
    expect(safeNextPath('/')).toBe('/')
  })

  it.each([
    [null], [undefined], [''],
    ['leads'],
    ['//evil.com'],
    ['/\\evil.com'],
    ['/%2f%2fevil.com'],
    ['/%2F%2Fevil.com'],
    ['/%5cevil.com'],
    ['/a//evil.com'],
    ['https://evil.com'],
    ['/javascript:alert(1)'],
    ['/leads\nSet-Cookie: x=1'],
    ['/leads\u0000'],
    ['/login'],
    ['/login?next=/leads'],
    ['/api/dashboard'],
    ['/api'],
    ['/' + 'a'.repeat(2048)],
  ])('rejects %j', (raw) => {
    expect(safeNextPath(raw as string | null | undefined)).toBeNull()
  })
})

describe('middleware deep link', () => {
  it('carries the requested page as ?next= on the /login redirect', async () => {
    const res = await middleware(req('/leads?x=1'))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.pathname).toBe('/login')
    expect(loc.origin).toBe('http://localhost')
    expect(loc.searchParams.get('next')).toBe('/leads?x=1')
  })

  it('adds no next for the home page', async () => {
    const res = await middleware(req('/'))
    const loc = new URL(res.headers.get('location')!)
    expect(loc.pathname).toBe('/login')
    expect(loc.searchParams.has('next')).toBe(false)
  })

  it('still 401s API requests without a redirect', async () => {
    const res = await middleware(req('/api/dashboard'))
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('robots.txt and security headers', () => {
  it('matcher exempts /robots.txt but still gates pages and APIs', () => {
    const re = new RegExp('^' + config.matcher[0] + '$')
    expect(re.test('/robots.txt')).toBe(false)
    expect(re.test('/favicon.ico')).toBe(false)
    expect(re.test('/leads')).toBe(true)
    expect(re.test('/api/dashboard')).toBe(true)
  })

  it('public/robots.txt disallows everything', () => {
    const body = readFileSync(join(process.cwd(), 'public/robots.txt'), 'utf8')
    expect(body).toMatch(/^User-agent: \*\s*\nDisallow: \/\s*$/m)
  })

  it('next.config sends anti-framing and nosniff on every path, and no other CSP directive', async () => {
    const rules = await nextConfig.headers!()
    const all = rules.find((r) => r.source === '/:path*')!
    const h = Object.fromEntries(all.headers.map((x) => [x.key, x.value]))
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Content-Security-Policy']).toBe("frame-ancestors 'none'")
  })
})
