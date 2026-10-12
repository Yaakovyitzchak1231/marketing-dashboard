// #98 review: segmentFromTextAction must show the REAL reason when the AI base URL is refused
// by the SSRF guard (it used to pre-resolve the config, get null, and say "no AI provider is
// configured"). These tests go through the action and the real config resolver; only the
// auth gate, the DB handle (none: env fallback) and the model call are stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/db', () => ({ getDb: () => null }))
vi.mock('@/lib/auth/act', () => ({ actorFor: async () => 'editor' }))
import { segmentFromTextAction } from '@/app/actions/segments'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('segmentFromTextAction surfaces why the AI provider is unusable', () => {
  it.each([
    ['a private address', 'https://10.0.0.5/v1', /base URL is not allowed: Must be a public address/],
    ['localhost', 'https://localhost/v1', /base URL is not allowed: Must be a public host/],
    ['a plain-http URL', 'http://api.example.com/v1', /base URL is not allowed: Must be an https/],
    ['a non-443 port', 'https://api.example.com:8443/v1', /base URL is not allowed: Port must be 443/],
  ])('%s: the person sees the guard reason, not the generic message', async (_n, baseUrl, reason) => {
    vi.stubEnv('AI_BASE_URL', baseUrl)
    vi.stubEnv('AI_MODEL', 'm')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await segmentFromTextAction('opened twice, never replied')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.result.configured).toBe(false)
    if (r.result.configured) throw new Error('unreachable')
    expect(r.result.reason).toMatch(reason)
    expect(r.result.reason).not.toBe('no AI provider is configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with nothing configured it says to set it up in Settings', async () => {
    vi.stubEnv('AI_BASE_URL', '')
    vi.stubEnv('AI_MODEL', '')
    const r = await segmentFromTextAction('opened twice')
    expect(r).toMatchObject({ ok: true, result: { configured: false, reason: expect.stringMatching(/Settings/) } })
  })
})
