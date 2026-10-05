import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The API routes build their Supabase client through `getRequestClient`, not
 * from a module-level singleton. These tests therefore mock THAT function --
 * mocking `@/lib/supabase` no longer intercepts anything the routes touch,
 * which is why this file previously read `undefined` off every response
 * instead of the payload the route actually built.
 */
const mockSupabaseApi = vi.hoisted(() => {
  /**
   * A thenable chain that resolves to a per-query result.
   *
   * `GET /api/campaigns` issues three queries and needs them to resolve
   * DIFFERENTLY, including in the cross-check tests where the two counts must
   * disagree. A single shared chain with one `mockResolvedValue` cannot express
   * that, so `select(_, { head: true })` forks to a chain tagged by which count
   * it is asking for. The tag is read off the selected columns, which is also
   * how the two differ in production: one embeds `daily_metrics`, one does not.
   *
   * The previous harness also leaked between tests -- `vi.clearAllMocks()` does
   * not reset implementations, so a `limit.mockResolvedValue` from one test
   * survived into the next. Results are held in a registry that `beforeEach`
   * resets outright.
   */
  type Result = { data?: unknown; count?: number | null; error?: unknown }
  const results: Record<'rows' | 'windowed' | 'portfolio', Result> = {
    rows: {},
    windowed: {},
    portfolio: {},
  }
  /** Every `select()` the route issued, so a test can assert on the OPTIONS. */
  const selectCalls: { columns?: string; options?: unknown }[] = []

  const DEFAULT: Result = { data: [], count: null, error: null }

  const build = (kind: 'rows' | 'windowed' | 'portfolio') => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.from = vi.fn(() => build('rows'))
    chain.select = vi.fn((columns?: string, opts?: { head?: boolean }) => {
      selectCalls.push({ columns, options: opts })
      if (opts?.head !== true) return self()
      return build(columns?.includes('daily_metrics') ? 'windowed' : 'portfolio')
    })
    chain.gte = vi.fn(self)
    chain.lte = vi.fn(self)
    chain.eq = vi.fn(self)
    chain.order = vi.fn(self)
    chain.inner = vi.fn(self)
    chain.head = vi.fn(self)
    // `limit` returns the chain so routes that chain past it (overview does
    // `.limit(1).single()`) still work; the awaited value comes from `then`.
    chain.limit = vi.fn(self)
    chain.single = vi.fn(() => mockSupabaseApi.single())
    chain.maybeSingle = vi.fn(() => mockSupabaseApi.maybeSingle())
    chain.then = (onFulfilled?: (value: unknown) => unknown) =>
      Promise.resolve(
        // An empty result means "this test set nothing", so fall back to the
        // empty set. Keyed on emptiness, NOT on falsiness of `count`: a count
        // of 0 is a measurement the source reported, and treating it as absent
        // here would silently reproduce the very bug these tests guard.
        Object.keys(results[kind]).length === 0 ? DEFAULT : results[kind],
      ).then(onFulfilled)
    return chain
  }

  const root = build('rows') as Record<string, unknown>
  void root

  return {
    /**
     * A FRESH, NON-THENABLE client for each `getRequestClient` call.
     *
     * This has to be a facade rather than a builder. supabase-js query builders
     * are thenable, and a builder handed back from `getRequestClient` would be
     * adopted by the awaiting promise machinery -- `await getRequestClient()`
     * would resolve the builder's own result instead of yielding a client, and
     * the route would fail on `.from is not a function`.
     */
    newClient: () => ({ from: vi.fn(() => build('rows')) }),
    /** Every `select(columns, options)` the route issued. */
    selectCalls,
    /** Result for the rows query. */
    setRows: (value: Result) => {
      results.rows = value
    },
    /** The two `head: true` counts, set independently so a test can make them disagree. */
    setCounts: (windowed: number | null, portfolio: number | null) => {
      results.windowed = { count: windowed }
      results.portfolio = { count: portfolio }
    },
    reset: () => {
      results.rows = {}
      results.windowed = {}
      results.portfolio = {}
      selectCalls.length = 0
    },
    single: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
})

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(async () => mockSupabaseApi.newClient())
}))

import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'

describe('API Layer - Null Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSupabaseApi.reset()
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
    /**
     * One campaign, reported one day. The truncation tests all need a list
     * SHORTER than the count alongside it, which is the shape that makes the
     * row cap visible: without a second row there is nothing for `total` to be
     * larger than.
     */
    const oneCampaign = {
      id: 'camp-1',
      external_id: 'ext-1',
      name: 'Campaign 1',
      status: 'active',
      created_at: '2024-01-01T00:00:00Z',
      daily_metrics: [
        {
          metric_date: '2024-01-15',
          emails_sent: 100,
          replies_total: 10,
          replies_human: 8,
          replies_autoresponder: 2,
          opportunities: 5,
          bounces: 2,
          open_rate: null,
          unsubscribe: null,
        },
      ],
    }

    it('returns null for missing metrics in daily_metrics', async () => {
      // The route uses .limit(100) not .single() - mock the chain correctly
      mockSupabaseApi.setRows({
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
      mockSupabaseApi.setRows({
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

    it('asks for both counts with head:true, and only the counts', async () => {
      // The load-bearing half of the truncation fix is the count REQUESTS. The
      // mock used to discard `select`'s arguments entirely, so every `total`
      // below came from a hand-written number and deleting the option left the
      // suite green while the disclosure went inert in production. The calls
      // themselves are asserted, not just their consequence.
      //
      // `head: true` matters as much as `count: 'exact'`: it asks for the count
      // with no body, so the number that comes back cannot be confused with the
      // length of a row array.
      mockSupabaseApi.setRows({ data: [], error: null })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      await campaignsGET(request)

      const counted = mockSupabaseApi.selectCalls.filter(
        (c) => (c.options as { count?: string } | undefined)?.count === 'exact',
      )
      expect(counted).toHaveLength(2)
      // One embeds daily_metrics (the windowed count), one does not (the
      // portfolio count, whose unit is campaigns by construction).
      expect(counted.filter((c) => c.columns?.includes('daily_metrics'))).toHaveLength(1)
      expect(counted.filter((c) => !c.columns?.includes('daily_metrics'))).toHaveLength(1)
      for (const call of counted) {
        expect((call.options as { head?: boolean }).head).toBe(true)
      }
      // The rows query must NOT ask to be counted: its count would arrive
      // attached to a body, and the unit of that number is the thing under
      // suspicion here.
      const rowsCall = mockSupabaseApi.selectCalls.find(
        (c) => (c.options as { count?: string } | undefined)?.count !== 'exact',
      )
      expect(rowsCall).toBeDefined()
    })

    it('publishes the row cap so truncation is disclosable without a count', async () => {
      // The one completeness signal that needs no number to be trusted. If every
      // count query fails, this is all the table has, so it has to travel with
      // the rows.
      mockSupabaseApi.setRows({ data: [], error: null })

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.row_limit).toBe(100)
    })

    it('publishes the count when the two measurements agree', async () => {
      // 148 campaigns match the window; 200 exist in total. The gap is the only
      // signal the UI has that the row cap truncated the portfolio -- so total
      // must come from the driver's count, never from the array length.
      mockSupabaseApi.setRows({ data: [oneCampaign], error: null })
      mockSupabaseApi.setCounts(148, 200)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBe(148)
      expect(data.campaigns.length).toBe(1)
      expect(data.total).toBeGreaterThan(data.campaigns.length)
    })

    it('REFUSES a count larger than the whole portfolio', async () => {
      // The falsification the cross-check exists for. If the windowed count
      // exceeded the count of ALL campaigns, it cannot be counting campaigns --
      // it is counting joined daily_metrics rows, one per campaign per reported
      // day. Publishing it would state a number in the wrong unit: "Showing
      // 100 of 1,036 campaigns" for a portfolio of 200.
      mockSupabaseApi.setRows({ data: [oneCampaign], error: null })
      mockSupabaseApi.setCounts(1036, 200)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
      // The rows still ship: a disclosure we cannot support must not cost the
      // reader the page.
      expect(data.campaigns).toHaveLength(1)
    })

    it('reports total as null when the portfolio count is unavailable', async () => {
      // Half the cross-check is missing, so the unit cannot be established.
      mockSupabaseApi.setCounts(148, null)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
    })

    it('reports total as null, not the row count, when no count is offered', async () => {
      // Neither count came back: the source did not say how many campaigns
      // match. A length fallback would emit total === campaigns.length, so the
      // truncation notice would stay silent on precisely the truncated lists it
      // exists to expose.
      mockSupabaseApi.setRows({ data: [oneCampaign], error: null })
      mockSupabaseApi.setCounts(null, null)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
      expect(data.campaigns.length).toBe(1)
      expect(data.total).not.toBe(data.campaigns.length)
    })

    it('reports total as null when the driver count is not a real number', async () => {
      // supabase-js derives `count` with `parseInt(contentRange[1])`, so a
      // `Content-Range: */*` header -- which PostgREST sends when it will not
      // count the set -- arrives as NaN rather than null. NaN is not nullish, so
      // `count ?? null` passes it straight through, and only the JSON serializer
      // turns it into null on screen. The code has to refuse it instead.
      mockSupabaseApi.setCounts(NaN, 200)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
    })

    it('reports total as null when the count is smaller than the rows returned', async () => {
      // Contradiction: a population of N cannot yield more than N rows, so one
      // of the two queries is measuring something other than what was asked and
      // neither number is published.
      mockSupabaseApi.setRows({ data: [oneCampaign], error: null })
      mockSupabaseApi.setCounts(0, 200)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBeNull()
    })

    it('keeps a zero total, which is a measurement and not an absence', async () => {
      // The counterweight to the guards above: `Number.isFinite` is not a falsy
      // check and must not become one. Zero campaigns in the window is a result
      // the source reported, and 0 <= portfolio, so it survives the cross-check.
      mockSupabaseApi.setRows({ data: [], error: null })
      mockSupabaseApi.setCounts(0, 200)

      const request = new NextRequest(new URL('/api/campaigns?range=7d', 'http://localhost'))
      const response = await campaignsGET(request)
      const data = await response.json()

      expect(data.total).toBe(0)
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