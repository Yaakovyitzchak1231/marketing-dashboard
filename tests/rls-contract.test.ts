import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * These tests cover the RLS contract in supabase/migrations/002_enable_rls.sql.
 *
 * The point is not that a client can fetch a row -- it is that the WRONG client
 * cannot. Under RLS an anon-key client gets HTTP 200 with `[]`, not a 403, so
 * the failure mode is silent: the dashboard renders an honest-looking empty
 * state while the data sits unread. Anything that lets an unauthenticated or
 * wrongly-scoped request reach PostgREST must therefore be an error, never an
 * empty array.
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
  inner: vi.fn().mockReturnThis(),
}))

const mockGetRequestClient = vi.hoisted(() => vi.fn())
const mockUnauthorizedClient = vi.hoisted(() => vi.fn(() => mockSupabaseApi))

vi.mock('@/lib/supabase-request', () => ({
  getRequestClient: mockGetRequestClient,
  unauthorizedClient: mockUnauthorizedClient,
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => new Map()),
  headers: vi.fn(async () => new Map()),
}))

import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost'))

describe('RLS contract: no unauthenticated read can reach the data path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getRequestClient resolving to null answers 503, not an empty 200', async () => {
    // A null client means "no session could be resolved". Returning 200 with an
    // empty campaigns array is exactly the lie this card exists to prevent.
    mockGetRequestClient.mockResolvedValue(null)

    const res = await campaignsGET(req('/api/campaigns?range=7d'))
    expect(res.status).toBe(503)

    const overview = await overviewGET(req('/api/overview?range=7d'))
    expect(overview.status).toBe(503)

    const trend = await trendGET(req('/api/campaigns/camp-1/trend?range=7d'), {
      params: Promise.resolve({ id: 'camp-1' }),
    })
    expect(trend.status).toBe(503)
  })

  it('a query error is a 500 with no figure invented', async () => {
    mockGetRequestClient.mockResolvedValue(mockSupabaseApi)
    mockSupabaseApi.single.mockResolvedValue({
      data: null,
      error: { code: 'PGRST100', message: 'parse error' },
    })

    const res = await overviewGET(req('/api/overview?range=7d'))
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.error).toBeTruthy()
    // The error body must not smuggle a zero into a failed read.
    expect(body.emails_sent).toBeUndefined()
    expect(body.reply_rate).toBeUndefined()
  })
})

describe('RLS contract: a session read returns real rows, not []', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRequestClient.mockResolvedValue(mockSupabaseApi)
  })

  it('campaigns returns the rows it received', async () => {
    mockSupabaseApi.limit.mockResolvedValue({
      data: [
        {
          id: 'camp-1',
          external_id: 'ext-1',
          name: 'PB Signups / Leads',
          status: 'pending',
          created_at: '2026-09-30T03:38:11Z',
          daily_metrics: [
            {
              metric_date: '2026-09-30',
              emails_sent: 31893,
              replies_total: 1696,
              replies_human: 1357,
              replies_autoresponder: 8,
              opportunities: 951,
              bounces: 85,
              open_rate: null,
              unsubscribe: null,
            },
          ],
        },
      ],
      error: null,
    })

    const res = await campaignsGET(req('/api/campaigns?range=7d'))
    const data = await res.json()

    expect(data.campaigns).toHaveLength(1)
    expect(data.campaigns[0].emails_sent).toBe(31893)
    // 1357 / 31893 = 0.04255..., rounded to 4dp
    expect(data.campaigns[0].reply_rate).toBeCloseTo(0.0425, 4)
  })

  it('orders the embedded daily_metrics by bare column with referencedTable', async () => {
    // Regression guard. The qualified form `daily_metrics.metric_date` is not
    // valid PostgREST syntax and returns PGRST100 at runtime, which surfaced as
    // a 404 "Campaign not found" and an empty production dashboard.
    mockSupabaseApi.single.mockResolvedValue({
      data: {
        id: 'camp-1',
        external_id: 'ext-1',
        name: 'Campaign 1',
        status: 'pending',
        created_at: '2026-09-30T03:38:11Z',
        daily_metrics: [],
      },
      error: null,
    })

    await trendGET(req('/api/campaigns/camp-1/trend?range=30d'), {
      params: Promise.resolve({ id: 'camp-1' }),
    })

    expect(mockSupabaseApi.order).toHaveBeenCalledWith('metric_date', {
      ascending: true,
      referencedTable: 'daily_metrics',
    })
  })
})
