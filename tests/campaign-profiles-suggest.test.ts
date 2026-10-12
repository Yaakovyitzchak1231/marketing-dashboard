import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { getProfile } from '@/lib/campaign-profiles/store'
import { extractJson, getAiConfig, suggestCampaignProfile, validateSuggestions, verifyFeed } from '@/lib/campaign-profiles/suggest'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

function chatReturning(content: string) {
  return vi.fn(async () => content)
}

/** A tiny mock fetch for the verification pass: feeds look like RSS with a recent item,
 * everything else answers 200 with no robots.txt (so pages "load"). No real network ever. */
function mockVerifyFetch(): typeof fetch {
  return (vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/robots.txt')) return { ok: false, status: 404, text: async () => '' }
    if (u.endsWith('/rss') || u.includes('feed')) {
      const today = new Date().toISOString()
      return { ok: true, status: 200, text: async () => `<?xml version="1.0"?><rss><channel><item><pubDate>${today}</pubDate></item></channel></rss>` }
    }
    return { ok: true, status: 200, text: async () => '<html></html>' }
  }) as unknown) as typeof fetch
}

const GOOD_JSON = JSON.stringify({
  industry: 'Dental clinics',
  vertical: 'General dentistry',
  description: 'Independent and small-group dental practices.',
  icp: { business_types: ['dental practice'], geographies: ['MD', 'VA'], roles: ['office manager', 'owner dentist'] },
  value_prop: 'Fill the schedule with better patients',
  utm: { source: 'tapdash', medium: 'email', campaign: 'dental-q4' },
  kpis: [{ metric: 'reply_rate', target: 0.05, period: 'month' }],
  items: [
    { kind: 'keyword', name: 'dental implants marketing', rationale: 'high intent search term' },
    { kind: 'competitor', name: 'Dentrix', value: 'dentrix.com', config: { pricing_url: 'https://www.dentrix.com/pricing' }, rationale: 'practice management competitor' },
    { kind: 'feed', name: 'Dental Economics', value: 'https://www.dentaleconomics.com/rss', rationale: 'industry news' },
    { kind: 'signal_rule', name: 'New office manager hired', config: { type: 'hiring' }, rationale: 'buying signal' },
    { kind: 'fingerprint', name: 'Dentrix widget', config: { patterns: ['dentrix.com/widget'] }, rationale: 'tech detection' },
  ],
})

describe('campaign-profiles AI-assisted suggest', () => {
  let db: TestDb
  let campaignId: number
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV }
  })
  afterEach(() => {
    process.env = OLD_ENV
  })

  beforeAll(async () => {
    db = await createTestDb()
    campaignId = (await createCampaign(db, 'owner', { name: 'Dental Q4' } as never)).id
  })
  afterAll(async () => {
    await db.close()
  })

  it('getAiConfig reads env, and is unset when AI_BASE_URL/AI_MODEL are missing', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_MODEL
    delete process.env.AI_API_KEY
    expect(await getAiConfig()).toBeNull()
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    process.env.AI_MODEL = 'llama3.1'
    expect(await getAiConfig()).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: null, model: 'llama3.1' })
    process.env.AI_API_KEY = 'sk-free'
    expect((await getAiConfig())?.apiKey).toBe('sk-free')
  })

  it('reports {configured:false} when no AI provider is set up, and never touches the DB', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_MODEL
    const before = await getProfile(db, campaignId)
    const r = await suggestCampaignProfile(db, 'owner', { campaign_id: campaignId, industry: 'Dental clinics' })
    expect(r).toEqual({ configured: false, reason: expect.stringContaining('no AI provider') })
    const after = await getProfile(db, campaignId)
    expect(after.exists).toBe(before.exists)
  })

  it('parses a good JSON reply, saves items as suggested/ai, never auto-approves', async () => {
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    process.env.AI_MODEL = 'llama3.1'
    const chat = chatReturning(GOOD_JSON)
    const r = await suggestCampaignProfile(db, 'owner', { campaign_id: campaignId, industry: 'Dental clinics' }, { chat, verify: { fetchImpl: mockVerifyFetch() } })
    expect(r.configured).toBe(true)
    if (!r.configured) throw new Error('unreachable')
    expect(r.items_saved).toBe(5)
    expect(r.items_dropped).toBe(0)
    expect(r.model).toBe('llama3.1')
    expect(r.verified_ok + r.verified_failed + r.not_applicable).toBe(5)
    const p = await getProfile(db, campaignId)
    expect(p.profile.industry).toBe('Dental clinics')
    expect(p.profile.setup_status).toBe('suggested')
    expect(p.profile.ai_model).toBe('llama3.1')
    const allItems = Object.values(p.items).flat()
    expect(allItems.length).toBe(5)
    for (const it of allItems) {
      expect(it.status).toBe('suggested')
      expect(it.source).toBe('ai')
    }
    const feed = p.items.feed[0]
    expect(feed.config.unverified).toBe(true)
  })

  it('survives a fenced reply (```json ... ```) and surrounding prose', async () => {
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    process.env.AI_MODEL = 'llama3.1'
    const fenced = 'Sure, here is the setup:\n```json\n' + GOOD_JSON + '\n```\nLet me know if you want more.'
    const c2 = (await createCampaign(db, 'owner', { name: 'Dental Q4 fenced' } as never)).id
    const chat = chatReturning(fenced)
    const r = await suggestCampaignProfile(db, 'owner', { campaign_id: c2, industry: 'Dental clinics' }, { chat, verify: { fetchImpl: mockVerifyFetch() } })
    expect(r.configured).toBe(true)
    if (!r.configured) throw new Error('unreachable')
    expect(r.items_saved).toBe(5)
  })

  it('survives garbage output: drops invalid items, reports how many were dropped, never throws out the good ones', async () => {
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    process.env.AI_MODEL = 'llama3.1'
    const garbage = JSON.stringify({
      industry: 'Dental clinics',
      items: [
        { kind: 'keyword', name: 'dental seo' }, // good
        { kind: 'not_a_real_kind', name: 'bogus' }, // bad kind
        { kind: 'feed', name: 'no url feed' }, // missing http(s) value
        { kind: 'competitor', name: '' }, // missing name
        { kind: 'signal_rule', name: 'bad rule', config: { type: 'nonsense' } }, // bad type
        { kind: 'fingerprint', name: 'bad fp', config: { patterns: [] } }, // empty patterns
        'not even an object',
      ],
    })
    const c3 = (await createCampaign(db, 'owner', { name: 'Dental Q4 garbage' } as never)).id
    const chat = chatReturning(garbage)
    const r = await suggestCampaignProfile(db, 'owner', { campaign_id: c3, industry: 'Dental clinics' }, { chat, verify: { fetchImpl: mockVerifyFetch() } })
    expect(r.configured).toBe(true)
    if (!r.configured) throw new Error('unreachable')
    expect(r.items_saved).toBe(1)
    expect(r.items_dropped).toBe(6)
    expect(r.dropped_reasons.length).toBe(6)
  })

  it('throws a clear ProfileError when the reply has no JSON object at all', () => {
    expect(() => extractJson('Sorry, I cannot help with that.')).toThrow(/no JSON object/)
  })

  it('validateSuggestions requires an object, not an array or primitive', () => {
    expect(() => validateSuggestions([1, 2, 3])).toThrow(/must be a JSON object/)
    expect(() => validateSuggestions('nope')).toThrow(/must be a JSON object/)
  })

  it('verifyFeed: ok on a real-looking RSS response, false on timeout/non-xml/non-2xx (mocked fetch)', async () => {
    const rssFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>' })) as unknown as typeof fetch
    expect((await verifyFeed('https://example.com/feed', rssFetch)).ok).toBe(true)

    const htmlFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html><body>not a feed</body></html>' })) as unknown as typeof fetch
    const bad = await verifyFeed('https://example.com/not-a-feed', htmlFetch)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/RSS\/Atom/)

    const errFetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as unknown as typeof fetch
    const err = await verifyFeed('https://example.com/missing', errFetch)
    expect(err.ok).toBe(false)
    expect(err.reason).toBe('HTTP 404')

    expect((await verifyFeed('not-a-url')).ok).toBe(false)

    const abortFetch = vi.fn(async (_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }) as unknown as typeof fetch
    const timeoutResult = await verifyFeed('https://example.com/slow', abortFetch)
    expect(timeoutResult.ok).toBe(false)
    expect(timeoutResult.reason).toMatch(/timed out/)
  }, 10_000)
})
