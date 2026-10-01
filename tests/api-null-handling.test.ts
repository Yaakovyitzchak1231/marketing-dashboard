import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The API routes build their Supabase client through `getRequestClient`, not
 * from a module-level singleton. These tests therefore mock THAT function --
 * mocking `@/lib/supabase` no longer intercepts anything the routes touch,
 * which is why this file previously read `undefined` off every response
 * instead of the payload the route actually built.
 */
const mockSupabaseApi = vi.hoisted(() => ({
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  inner: vi.fn().mockReturnThis()
}))

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(async () => mockSupabaseApi)
}))

import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'

describe('API Layer - Null Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/overview', () => {
    it('returns null for all metrics when no data exists', async () => {
      mockSupabaseApi.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
      
      const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
      const response = await overviewGET(request)
      const data = await response.json()
      
      expect(data.emails_sent).toBeNull()
      expect(data.replies_human).toBeNull()
      expect(data.replies_autoresponder).toBeNull()
      expect(data.bounces).toBeNull()
      expect(data.opportunities).toBeNull()
      expect(data.opportunity_value).toBeNull()
      expect(data.mailbox_count).toBeNull()
      expect(data.healthy_mailboxes).toBeNull()
      expect(data.reply_rate).toBeNull()
      expect(data.bounce_rate).toBeNull()
    })

    it('returns null for rates when sent is 0 or null', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          emails_sent: 0,
          replies_human: 5,
          replies_autoresponder: 2,
          bounces: 1,
          opportunities: 10,
          opportunity_value: 1000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
      const response = await overviewGET(request)
      const data = await response.json()
      
      expect(data.emails_sent).toBe(0)
      expect(data.replies_human).toBe(5)
      expect(data.reply_rate).toBeNull()  // 0 sent -> null rate
      expect(data.bounce_rate).toBeNull()  // 0 sent -> null rate
    })

    it('returns null for open_rate and unsubscribe when API does not provide them (populated path)', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          emails_sent: 1000,
          replies_human: 50,
          replies_autoresponder: 10,
          bounces: 5,
          opportunities: 20,
          opportunity_value: 2000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
      const response = await overviewGET(request)
      const data = await response.json()
      
      // These are not in the accounts table - they're API limitations
      // Must explicitly return null, never omit the keys
      expect(data.open_rate).toBeNull()
      expect(data.unsubscribe).toBeNull()
      
      // Other fields should have values
      expect(data.emails_sent).toBe(1000)
      expect(data.replies_human).toBe(50)
      expect(data.replies_autoresponder).toBe(10)
    })

    it('computes reply_rate from raw counts, never averages', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          emails_sent: 1000,
          replies_human: 50,
          replies_autoresponder: 10,
          bounces: 5,
          opportunities: 20,
          opportunity_value: 2000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
      const response = await overviewGET(request)
      const data = await response.json()
      
      // 50/1000 = 0.05
      expect(data.reply_rate).toBe(0.05)
      // Should NOT be 0.06 (which would be (50+10)/1000 - wrong, includes autoresponders)
      expect(data.reply_rate).not.toBe(0.06)
    })

    it('returns null for rates when sent is 0', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          emails_sent: 0,
          replies_human: 5,
          replies_autoresponder: 2,
          bounces: 1,
          opportunities: 10,
          opportunity_value: 1000,
          mailbox_count: 5,
          healthy_mailboxes: 4
        },
        error: null
      })
      
      const request = new NextRequest(new URL('/api/overview?range=7d', 'http://localhost'))
      const response = await overviewGET(request)
      const data = await response.json()
      
      expect(data.emails_sent).toBe(0)
      expect(data.replies_human).toBe(5)
      expect(data.reply_rate).toBeNull()  // 0 sent -> null rate
      expect(data.bounce_rate).toBeNull()  // 0 sent -> null rate
    })
  })

  describe('GET /api/campaigns', () => {
    it('returns null for missing metrics in daily_metrics', async () => {
      // The route uses .limit(100) not .single() - mock the chain correctly
      mockSupabaseApi.limit.mockResolvedValue({
        data: [
          {
            id: 'camp-1',
            external_id: 'ext-1',
            name: 'Campaign 1',
            status: 'active',
            created_at: '2024-01-01T00:00:00Z',
            daily_metrics: [{
              metric_date: '2024-01-15',
              emails_sent: 100,
              replies_total: 10,
              replies_human: 8,
              replies_autoresponder: 2,
              opportunities: 5,
              bounces: 2,
              open_rate: null,  // API doesn't provide
              unsubscribe: null  // API doesn't provide
            }]
          }
        ],
        error: null
      })
      
      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()
      
      expect(data.campaigns[0].open_rate).toBeNull()
      expect(data.campaigns[0].unsubscribe).toBeNull()
    })

    it('never coerces null to 0 for rates', async () => {
      mockSupabaseApi.limit.mockResolvedValue({
        data: [{
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [{
            metric_date: '2024-01-15',
            emails_sent: 100,
            replies_total: 10,
            replies_human: null,  // Missing
            replies_autoresponder: null,
            opportunities: null,
            bounces: null,
            open_rate: null,
            unsubscribe: null
          }]
        }],
        error: null
      })
      
      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()
      
      expect(data.campaigns[0].reply_rate).toBeNull()
      expect(data.campaigns[0].bounce_rate).toBeNull()
      expect(data.campaigns[0].replies_human).toBeNull()
      expect(data.campaigns[0].bounces).toBeNull()
    })

    it('asks for an exact count on the same select() that reads the rows', async () => {
      // The load-bearing half of the truncation fix is the `{ count: 'exact' }`
      // OPTION, and the mock chain used to throw it away: `select` is a
      // `mockReturnThis()`, so its arguments never reach `limit` and every
      // `total` above came from a hand-written `count: 148`. Deleting the option
      // left all of those tests green while the disclosure went inert in
      // production -- PostgREST stops returning a count, the route's `count` is
      // null, and the UI quietly claims nothing was truncated. So the call
      // itself is asserted, not just its consequence.
      mockSupabaseApi.limit.mockResolvedValue({ data: [], error: null, count: 0 })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      await campaignsGET(request)

      expect(mockSupabaseApi.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' })
    })

    it('reports total as null when the driver count is not a real number', async () => {
      // supabase-js derives `count` with `parseInt(contentRange[1])`, so a
      // `Content-Range: */*` header -- which PostgREST sends when it will not
      // count the set -- arrives as NaN rather than null. NaN is not nullish, so
      // `count ?? null` passes it straight through, and only the JSON serializer
      // turns it into null on screen. The code has to refuse it instead.
      mockSupabaseApi.limit.mockResolvedValue({ data: [], error: null, count: NaN })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
    })

    it('keeps a zero total, which is a measurement and not an absence', async () => {
      // The counterweight to the guard above: `Number.isFinite` is not a falsy
      // check, and must not become one. Zero campaigns in the window is a
      // result the source reported.
      mockSupabaseApi.limit.mockResolvedValue({ data: [], error: null, count: 0 })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBe(0)
    })

    it('reports the driver count as total so a capped list can be disclosed', async () => {
      // One row back, 148 matching campaigns according to the same query. The
      // gap between the two is the only signal the UI has that the row cap
      // truncated the portfolio -- so total must come from the driver's count,
      // never from the array length.
      mockSupabaseApi.limit.mockResolvedValue({
        data: [{
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [{
            metric_date: '2024-01-15',
            emails_sent: 100,
            replies_total: 10,
            replies_human: 8,
            replies_autoresponder: 2,
            opportunities: 5,
            bounces: 2,
            open_rate: null,
            unsubscribe: null
          }]
        }],
        error: null,
        count: 148
      })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBe(148)
      expect(data.campaigns.length).toBe(1)
      // The disclosure only fires when total exceeds the rows returned.
      expect(data.total).toBeGreaterThan(data.campaigns.length)
    })

    it('reports total as null, not the row count, when the driver gives no count', async () => {
      // No `count` key at all: the source did not say how many campaigns match.
      // A length fallback here would emit total === 1, which equals
      // campaigns.length, so isPartial would be false and the truncation notice
      // would stay silent on precisely the truncated lists it exists to expose.
      // null renders nothing instead of making a claim we cannot support.
      mockSupabaseApi.limit.mockResolvedValue({
        data: [{
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [{
            metric_date: '2024-01-15',
            emails_sent: 100,
            replies_total: 10,
            replies_human: 8,
            replies_autoresponder: 2,
            opportunities: 5,
            bounces: 2,
            open_rate: null,
            unsubscribe: null
          }]
        }],
        error: null
      })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
      expect(data.campaigns.length).toBe(1)
      expect(data.total).not.toBe(data.campaigns.length)
    })
  })

  describe('GET /api/campaigns/[id]/trend', () => {
    it('returns null for open_rate and unsubscribe in trend data', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [
            {
              metric_date: '2024-01-14',
              emails_sent: 50,
              replies_total: 5,
              replies_human: 4,
              replies_autoresponder: 1,
              opportunities: 2,
              bounces: 1,
              open_rate: null,
              unsubscribe: null
            },
            {
              metric_date: '2024-01-15',
              emails_sent: 60,
              replies_total: 6,
              replies_human: 5,
              replies_autoresponder: 1,
              opportunities: 3,
              bounces: 0,
              open_rate: null,
              unsubscribe: null
            }
          ]
        },
        error: null
      })
      
      const params = Promise.resolve({ id: 'camp-1' })
      const request = new NextRequest(new URL('/api/campaigns/camp-1/trend?range=7d', 'http://localhost'))
      const response = await trendGET(request, { params })
      const data = await response.json()
      
      expect(data.trend[0].open_rate).toBeNull()
      expect(data.trend[0].unsubscribe).toBeNull()
      expect(data.trend[1].open_rate).toBeNull()
      expect(data.trend[1].unsubscribe).toBeNull()
    })

    it('computes daily rates from raw counts per day', async () => {
      mockSupabaseApi.single.mockResolvedValue({
        data: {
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'Campaign 1',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          daily_metrics: [
            {
              metric_date: '2024-01-14',
              emails_sent: 100,
              replies_total: 10,
              replies_human: 8,
              replies_autoresponder: 2,
              opportunities: 5,
              bounces: 2,
              open_rate: null,
              unsubscribe: null
            }
          ]
        },
        error: null
      })
      
      const params = Promise.resolve({ id: 'camp-1' })
      const request = new NextRequest(new URL('/api/campaigns/camp-1/trend?range=7d', 'http://localhost'))
      const response = await trendGET(request, { params })
      const data = await response.json()
      
      // 8/100 = 0.08
      expect(data.trend[0].reply_rate).toBe(0.08)
      // 2/100 = 0.02
      expect(data.trend[0].bounce_rate).toBe(0.02)
    })
  })
})