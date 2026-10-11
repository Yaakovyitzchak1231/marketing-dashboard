import { describe, it, expect, vi, afterEach } from 'vitest'
import { handle, umamiAuthHeaders } from '../runner/handlers/integration_umami.mjs'

const ENV_KEYS = ['UMAMI_API_URL', 'UMAMI_API_TOKEN', 'UMAMI_USERNAME', 'UMAMI_PASSWORD', 'UMAMI_API_KEY', 'UMAMI_WEBSITE_ID']

function ctxWith() {
  const ops = vi.fn(async (op: string, _args?: unknown) => (op === 'campaign_for_utm_campaign' ? { campaign_id: 7 } : { ok: true }))
  return { ctx: { payload: {}, campaignId: null, signal: new AbortController().signal, ops, log: vi.fn() }, ops }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('runner handler integration_umami: auth', () => {
  it('self-hosted token: sends Authorization: Bearer, not x-umami-api-key', async () => {
    process.env.UMAMI_API_URL = 'http://127.0.0.1:18540'
    process.env.UMAMI_API_TOKEN = 'tok123'
    process.env.UMAMI_WEBSITE_ID = 'site-1'
    const fetchMock = vi.fn(async (url: string, _init?: unknown) => (String(url).includes('/stats') ? okJson({ visits: { value: 12 } }) : okJson([{ x: 'dental', y: 5 }])))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, ops } = ctxWith()
    const out = await handle(ctx)
    expect(out).toEqual({ rows: 2 })
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers
      expect(headers.authorization).toBe('Bearer tok123')
      expect(headers['x-umami-api-key']).toBeUndefined()
    }
    const put = ops.mock.calls.find((c) => c[0] === 'put_integration_snapshots')!
    expect(put[1]).toMatchObject({ id: 'umami', snapshots: [{ metric: 'umami.visits_24h', value: 12 }, { dims: { utm_campaign: 'dental' }, value: 5, campaign_id: 7 }] })
  })

  it('username + password: logs in once and uses the returned token as Bearer', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: unknown) => (String(url).endsWith('/api/auth/login') ? okJson({ token: 'fresh' }) : okJson({})))
    vi.stubGlobal('fetch', fetchMock)
    const h = await umamiAuthHeaders('http://u', { UMAMI_USERNAME: 'runner', UMAMI_PASSWORD: 'pw' }, new AbortController().signal)
    expect(h).toEqual({ authorization: 'Bearer fresh' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(url).toBe('http://u/api/auth/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ username: 'runner', password: 'pw' })
  })

  it('a failed login is an error (the run fails), not silent zeros', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    await expect(umamiAuthHeaders('http://u', { UMAMI_USERNAME: 'x', UMAMI_PASSWORD: 'y' }, new AbortController().signal)).rejects.toThrow(/HTTP 401/)
  })

  it('Umami Cloud fallback: x-umami-api-key when only UMAMI_API_KEY is set', async () => {
    const h = await umamiAuthHeaders('http://u', { UMAMI_API_KEY: 'cloud' }, new AbortController().signal)
    expect(h).toEqual({ 'x-umami-api-key': 'cloud' })
  })

  it('no auth or no website: not configured, nothing fetched', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    process.env.UMAMI_API_TOKEN = 'tok'
    const { ctx } = ctxWith()
    expect(await handle(ctx)).toEqual({ ok: false, reason: 'not configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
