import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadShellData } from '@/lib/load-shell-data'
import type { Overview, CampaignList, CampaignTrend, Freshness } from '@/lib/api-types'

/**
 * The fetch layer. A dashboard that shows yesterday's data as though it were
 * today's is worse than one that says nothing, so the failure behaviour here
 * is load-bearing and is tested directly.
 *
 * These tests mock `fetch`, not the database: what is under test is how the
 * shell reacts to a bad or absent response, not whether Supabase works.
 */

const overview: Overview = {
  emails_sent: 31893,
  replies_human: 1357,
  replies_autoresponder: 39,
  bounces: 120,
  opportunities: 22,
  opportunity_value: 125000,
  mailbox_count: 12,
  healthy_mailboxes: 10,
  reply_rate: 0.0426,
  bounce_rate: 0.0038,
  open_rate: null,
  unsubscribe: null,
  range: '7d',
}

const campaigns: CampaignList = {
  campaigns: [],
  total: null,
  range: '7d',
  sort: 'emails_sent',
  order: 'desc',
}

const trend: CampaignTrend = {
  id: 'c1',
  external_id: 'e1',
  name: 'x',
  status: null,
  created_at: null,
  range: '30d',
  trend: [],
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadShellData', () => {
  it('returns the payloads when every route responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/overview')) return jsonResponse(overview)
        if (url.includes('/api/campaigns/') && url.includes('/trend')) return jsonResponse(trend)
        if (url.includes('/api/campaigns')) return jsonResponse(campaigns)
        return jsonResponse({})
      }),
    )

    const data = await loadShellData('c1', { generatedAt: '2026-09-30T14:05:00Z', collectionFailed: false })
    expect(data.overview).toEqual(overview)
    expect(data.campaigns).toEqual(campaigns)
    expect(data.trend).toEqual(trend)
  })

  it('returns a null overview when the route errors, never a zeroed one', async () => {
    // A 500 from the API means "we do not know". Returning a shape full of
    // zeros here is the single most likely way this dashboard starts lying.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/overview')) {
          throw new Error('boom')
        }
        return jsonResponse(campaigns)
      }),
    )

    const data = await loadShellData(null)
    expect(data.overview).toBeNull()
  })

  it('marks the collection as failed when the route errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/overview')) throw new Error('boom')
        return jsonResponse(campaigns)
      }),
    )

    const data = await loadShellData(null)
    expect(data.freshness.collectionFailed).toBe(true)
  })

  it('does not fetch a trend when no campaign id is given', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        return jsonResponse(url.includes('/api/overview') ? overview : campaigns)
      }),
    )

    const data = await loadShellData(null)
    expect(data.trend).toBeNull()
    expect(seen.some((u) => u.includes('/trend'))).toBe(false)
  })

  it('flags a trend failure without failing the whole page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/trend')) throw new Error('boom')
        if (url.includes('/api/overview')) return jsonResponse(overview)
        return jsonResponse(campaigns)
      }),
    )

    const data = await loadShellData('c1')
    expect(data.trend).toBeNull()
    expect(data.trendFailed).toBe(true)
    // The overview still renders -- one broken chart is not a broken dashboard.
    expect(data.overview).toEqual(overview)
  })

  it('rejects a response that is not the shape it claims to be', async () => {
    // A 200 carrying an error object must not be rendered as data. The shape
    // check is what stops a `{ error: ... }` body from becoming an empty KPI row.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/overview')) return jsonResponse({ error: 'nope' })
        return jsonResponse(campaigns)
      }),
    )

    const data = await loadShellData(null)
    expect(data.overview).toBeNull()
  })
})
