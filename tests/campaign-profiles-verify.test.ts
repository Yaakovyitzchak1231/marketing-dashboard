import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { verifyItem, verifyItemsAndSave } from '@/lib/campaign-profiles/verify'
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { addItems } from '@/lib/campaign-profiles/store'

function fakeFetch(handler: (url: string) => { ok: boolean; status: number; text?: () => Promise<string> }): typeof fetch {
  return (vi.fn(async (url: string | URL) => {
    const r = handler(String(url))
    const text = r.text ?? (async () => '')
    return { ...r, text, json: async () => JSON.parse(await text()) } as unknown as Response
  }) as unknown) as typeof fetch
}

describe('campaign-profile item verification (mocked fetch, no real network)', () => {
  it('kinds with nothing to check over HTTP are not_applicable', async () => {
    for (const kind of ['keyword', 'topic', 'search_phrase', 'place_category', 'negative_keyword', 'signal_rule', 'fingerprint', 'social_channel'] as const) {
      const r = await verifyItem({ kind, name: 'x', value: null, config: {} })
      expect(r.status).toBe('not_applicable')
    }
  })

  it('feed: ok with recent items, failed on stale/empty/non-xml/non-url', async () => {
    const today = new Date().toISOString()
    const fresh = fakeFetch(() => ({ ok: true, status: 200, text: async () => `<rss><channel><item><pubDate>${today}</pubDate></item><item><pubDate>${today}</pubDate></item></channel></rss>` }))
    const okR = await verifyItem({ kind: 'feed', name: 'News', value: 'https://example.com/feed', config: {} }, { fetchImpl: fresh })
    expect(okR.status).toBe('ok')
    expect(okR.detail).toMatch(/2 items/)

    const stale = fakeFetch(() => ({ ok: true, status: 200, text: async () => '<rss><channel><item><pubDate>Mon, 01 Jan 2001 00:00:00 GMT</pubDate></item></channel></rss>' }))
    const staleR = await verifyItem({ kind: 'feed', name: 'Old', value: 'https://example.com/old', config: {} }, { fetchImpl: stale })
    expect(staleR.status).toBe('failed')
    expect(staleR.detail).toMatch(/90 days/)

    const empty = fakeFetch(() => ({ ok: true, status: 200, text: async () => '<rss><channel></channel></rss>' }))
    const emptyR = await verifyItem({ kind: 'feed', name: 'Empty', value: 'https://example.com/empty', config: {} }, { fetchImpl: empty })
    expect(emptyR.status).toBe('failed')
    expect(emptyR.detail).toMatch(/no items/)

    const html = fakeFetch(() => ({ ok: true, status: 200, text: async () => '<html></html>' }))
    const htmlR = await verifyItem({ kind: 'feed', name: 'Html', value: 'https://example.com/page', config: {} }, { fetchImpl: html })
    expect(htmlR.status).toBe('failed')
    expect(htmlR.detail).toMatch(/RSS\/Atom/)

    const noUrl = await verifyItem({ kind: 'feed', name: 'NoUrl', value: null, config: {} })
    expect(noUrl.status).toBe('failed')

    const err404 = fakeFetch(() => ({ ok: false, status: 404 }))
    const err = await verifyItem({ kind: 'feed', name: 'Gone', value: 'https://example.com/gone', config: {} }, { fetchImpl: err404 })
    expect(err.status).toBe('failed')
    expect(err.detail).toBe('HTTP 404')
  })

  it('directory: page loads AND robots.txt must allow the path (required for directory)', async () => {
    const allowed = fakeFetch((u) => (u.includes('robots.txt') ? { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /members' } : { ok: true, status: 200 }))
    const okR = await verifyItem({ kind: 'directory', name: 'JA', value: 'https://example.com/find-a-jeweler', config: {} }, { fetchImpl: allowed })
    expect(okR.status).toBe('ok')

    const disallowed = fakeFetch((u) => (u.includes('robots.txt') ? { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /members' } : { ok: true, status: 200 }))
    const failR = await verifyItem({ kind: 'directory', name: 'JA members', value: 'https://example.com/members/search', config: {} }, { fetchImpl: disallowed })
    expect(failR.status).toBe('failed')
    expect(failR.detail).toMatch(/robots\.txt disallows/)
  })

  it('competitor/trade_show: page loads is enough (robots.txt noted, not required)', async () => {
    const f = fakeFetch((u) => (u.includes('robots.txt') ? { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /' } : { ok: true, status: 200 }))
    const r = await verifyItem({ kind: 'competitor', name: 'Toast', value: 'https://pos.toasttab.com', config: {} }, { fetchImpl: f })
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/robots\.txt disallows/)
    const noUrl = await verifyItem({ kind: 'competitor', name: 'No site', value: null, config: {} })
    expect(noUrl.status).toBe('not_applicable')
  })

  it('forum: a subreddit is checked via reddit\u2019s about.json; a plain URL falls back to page-load', async () => {
    const ok = fakeFetch((u) => (u.includes('about.json') ? { ok: true, status: 200, text: async () => JSON.stringify({ data: { subreddit_type: 'public', subscribers: 12345 } }) } : { ok: true, status: 200 }))
    const r = await verifyItem({ kind: 'forum', name: 'r/jewelry', value: 'r/jewelry', config: {} }, { fetchImpl: ok })
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/12,345/)

    const banned = fakeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { subreddit_type: 'banned' } }) }))
    const b = await verifyItem({ kind: 'forum', name: 'r/banned', value: 'r/banned', config: {} }, { fetchImpl: banned })
    expect(b.status).toBe('failed')

    const bad = await verifyItem({ kind: 'forum', name: 'nothing', value: 'nothing-at-all', config: {} })
    expect(bad.status).toBe('failed')
  })

  it('never throws: an unexpected error becomes a failed result, not an exception', async () => {
    const boom = (vi.fn(async () => { throw new Error('boom') }) as unknown) as typeof fetch
    const r = await verifyItem({ kind: 'feed', name: 'x', value: 'https://example.com/feed', config: {} }, { fetchImpl: boom })
    expect(r.status).toBe('failed')
    expect(r.detail).toContain('boom')
  })

  it('verifyItemsAndSave runs with bounded concurrency and writes verify_status/detail/verified_at', async () => {
    const db = await createTestDb()
    try {
      const c = (await createCampaign(db, 'owner', { name: 'Verify concurrency' } as never)).id
      const added = await addItems(db, 'owner', c, [
        { kind: 'keyword', name: 'k1' }, { kind: 'keyword', name: 'k2' }, { kind: 'keyword', name: 'k3' },
      ])
      const results = await verifyItemsAndSave(db, 'owner', added.added.map((a) => ({ id: a.id, kind: a.kind, name: a.name, value: a.value, config: a.config })), { concurrency: 2 })
      expect(results).toHaveLength(3)
      for (const r of results) expect(r.status).toBe('not_applicable')
      const read = await db.query<{ verify_status: string; verified_at: Date | null }>('select verify_status, verified_at from lp.campaign_profile_items where id = $1', [added.added[0].id])
      expect(read.rows[0].verify_status).toBe('not_applicable')
      expect(read.rows[0].verified_at).not.toBeNull()
    } finally {
      await db.close()
    }
  })
})
