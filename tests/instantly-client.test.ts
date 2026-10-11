import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
import { InstantlyClient, InstantlyError, buildQueryString, clearInstantlyMemo, clientFromEnv } from '@/lib/instantly/client'

const KEY = 'test-key-SECRET-123456'
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const err = (status: number, b: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers })

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof InstantlyClient>[0]> = {}) {
  return new InstantlyClient({ apiKey: KEY, fetchImpl, backoffMs: 0, memoTtlMs: 0, sleep: async () => {}, ...extra })
}

beforeEach(() => clearInstantlyMemo())

describe('InstantlyClient', () => {
  it('sends Bearer auth to the v2 base URL and asks Next to cache GETs for 5 minutes under the instantly tag', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => ok({ a: 1 }))
    await client(f as unknown as typeof fetch).get('/campaigns/analytics', { start_date: '2026-10-01', id: undefined })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.instantly.ai/api/v2/campaigns/analytics?start_date=2026-10-01')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect((init as { next?: { revalidate: number } }).next).toEqual({ revalidate: 300, tags: ['instantly'] })
  })

  it('follows next_starting_after across pages until the cursor runs out', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ id: 1 }, { id: 2 }], next_starting_after: 'c2' },
      c2: { items: [{ id: 3 }], next_starting_after: 'c3' },
      c3: { items: [{ id: 4 }], next_starting_after: null },
    }
    const f = vi.fn(async (u: RequestInfo | URL) => ok(pages[new URL(String(u)).searchParams.get('starting_after') ?? '']))
    const page = await client(f as unknown as typeof fetch).paginate<{ id: number }>('/accounts', { limit: 2 })
    expect(page.items.map((i) => i.id)).toEqual([1, 2, 3, 4])
    expect(page.truncated).toBe(false)
    expect(page.pages).toBe(3)
    expect(new URL(String(f.mock.calls[0][0])).searchParams.get('limit')).toBe('2')
  })

  it('reports truncated instead of silently stopping at the page cap', async () => {
    let n = 0
    const f = vi.fn(async () => ok({ items: [{ id: n }], next_starting_after: `c${++n}` }))
    const page = await client(f as unknown as typeof fetch).paginate('/accounts', { maxPages: 3 })
    expect(page.items).toHaveLength(3)
    expect(page.truncated).toBe(true)
  })

  it('stops when the API repeats a cursor (no infinite loop)', async () => {
    const f = vi.fn(async () => ok({ items: [{ id: 1 }], next_starting_after: 'same' }))
    const page = await client(f as unknown as typeof fetch).paginate('/accounts')
    expect(f).toHaveBeenCalledTimes(2)
    expect(page.truncated).toBe(false)
  })

  it('paginates POST list endpoints with starting_after in the body', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body))
      return ok(b.starting_after ? { items: [{ id: 'b' }] } : { items: [{ id: 'a' }], next_starting_after: 'a' })
    })
    const page = await client(f as unknown as typeof fetch).paginate('/leads/list', { method: 'POST', body: { contacts: ['x@y.z'] }, limit: 10 })
    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ contacts: ['x@y.z'], limit: 10, starting_after: 'a' })
  })

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const sleeps: number[] = []
    const f = vi.fn()
      .mockResolvedValueOnce(err(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(err(503))
      .mockResolvedValueOnce(ok({ fine: true }))
    const c = client(f as unknown as typeof fetch, { backoffMs: 100, sleep: async (ms) => { sleeps.push(ms) } })
    await expect(c.get('/accounts')).resolves.toEqual({ fine: true })
    expect(f).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([2000, 200])
  })

  it('does not retry other 4xx, and never puts the key in the error', async () => {
    const f = vi.fn(async () => err(401, { message: `bad token ${KEY}` }))
    const e = (await client(f as unknown as typeof fetch).get('/accounts').catch((x: InstantlyError) => x)) as InstantlyError
    expect(e).toBeInstanceOf(InstantlyError)
    expect(e.status).toBe(401)
    expect(f).toHaveBeenCalledTimes(1)
    expect(e.message).toMatch(/rejected the API key/)
    expect(e.message).not.toContain(KEY)
  })

  it('gives up after the retries with plain words', async () => {
    const f = vi.fn(async () => err(500))
    const e = (await client(f as unknown as typeof fetch, { retries: 2 }).get('/campaigns').catch((x: InstantlyError) => x)) as InstantlyError
    expect(f).toHaveBeenCalledTimes(3)
    expect(e.message).toBe('Instantly had a server error on /campaigns (HTTP 500).')
  })

  it('turns network failures and timeouts into InstantlyError without the key', async () => {
    const f = vi.fn(async () => { throw new Error(`socket hang up ${KEY}`) })
    const e = (await client(f as unknown as typeof fetch, { retries: 0 }).get('/campaigns').catch((x: InstantlyError) => x)) as InstantlyError
    expect(e).toBeInstanceOf(InstantlyError)
    expect(e.message).not.toContain(KEY)
  })

  it('refuses any POST that is not a read-only list call, before sending', async () => {
    const f = vi.fn()
    const e = (await client(f as unknown as typeof fetch).post('/campaigns/abc/pause', {}).catch((x: InstantlyError) => x)) as InstantlyError
    expect(e).toBeInstanceOf(InstantlyError)
    expect(f).not.toHaveBeenCalled()
  })

  it('memoises identical calls for the TTL (one network call for concurrent duplicates)', async () => {
    let t = 0
    const f = vi.fn(async () => ok({ n: 1 }))
    const c = client(f as unknown as typeof fetch, { memoTtlMs: 1000, now: () => t })
    await Promise.all([c.get('/accounts'), c.get('/accounts')])
    expect(f).toHaveBeenCalledTimes(1)
    t = 2000
    await c.get('/accounts')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('memoises GETs for at most 30 s (the shared Next cache covers the rest); POSTs for the full TTL', async () => {
    let t = 0
    const f = vi.fn(async () => ok({ items: [] }))
    const c = client(f as unknown as typeof fetch, { memoTtlMs: 300_000, now: () => t })
    await c.get('/accounts')
    await c.post('/leads/list', { contacts: ['a@x.com'] })
    expect(f).toHaveBeenCalledTimes(2)
    t = 31_000
    await c.get('/accounts')
    await c.post('/leads/list', { contacts: ['a@x.com'] })
    expect(f).toHaveBeenCalledTimes(3)
    clearInstantlyMemo()
    await c.post('/leads/list', { contacts: ['a@x.com'] })
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('joins array query values with commas and drops empty values', () => {
    expect(buildQueryString({ emails: ['a@x.com', 'b@x.com'], x: undefined, y: null, z: '' })).toBe('?emails=a%40x.com%2Cb%40x.com')
  })

  it('clientFromEnv is null without a key', () => {
    expect(clientFromEnv({})).toBeNull()
    expect(clientFromEnv({ INSTANTLY_API_KEY: '  ' })).toBeNull()
    expect(clientFromEnv({ INSTANTLY_API_KEY: KEY })).toBeInstanceOf(InstantlyClient)
  })
})
