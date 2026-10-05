import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/ideas/performance rolls daily_metrics up per idea.
 *
 * The route was refactored from `flatMap` + `sumCol` to a nested
 * `for...of` loop to avoid intermediate arrays. These tests pin the
 * semantics that refactor was not allowed to change: replies sum
 * across every campaign and every metric row of the idea, and an
 * idea with no numeric reply figure reports null -- never 0, which
 * would assert the idea produced no replies.
 *
 * `from(table)` returns a thenable builder, so the awaited value
 * resolves with the fixture recorded for that table.
 */
const fixtures: Record<string, { data: unknown; error?: unknown }> = {}
const mockSupabaseApi = {
  from: (table: string) => {
    const builder = {
      select: () => builder,
      order: () => builder,
      gte: () => builder,
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(fixtures[table] ?? { data: null, error: null }).then(
          onFulfilled,
        ),
    }
    return builder
  },
}

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(async () => mockSupabaseApi),
}))

import { GET as performanceGET } from '@/app/api/ideas/performance/route'

function seed(opts: {
  ideas: { id: string; title: string | null; status: string }[]
  campaigns: { id: string; idea_id: string | null }[]
  metrics: { campaign_id: string; replies_human: unknown }[]
  costs: { entity_ref: string | null; amount_usd: number }[]
}) {
  fixtures['ideas'] = { data: opts.ideas, error: null }
  fixtures['campaigns'] = { data: opts.campaigns }
  fixtures['daily_metrics'] = { data: opts.metrics }
  fixtures['costs'] = { data: opts.costs }
}

function call(): Promise<{ range: string; ideas: Record<string, unknown>[] }> {
  const request = new NextRequest(
    new URL('/api/ideas/performance?range=30d', 'http://localhost'),
  )
  return performanceGET(request).then((r) => r.json())
}

describe('GET /api/ideas/performance', () => {
  it('sums replies_human across every campaign and metric row of the idea', async () => {
    seed({
      ideas: [{ id: 'idea-a', title: 'Alpha', status: 'active' }],
      campaigns: [
        { id: 'c1', idea_id: 'idea-a' },
        { id: 'c2', idea_id: 'idea-a' },
      ],
      // c1 contributes two rows, c2 one: the sum must not stop at
      // the first row or the first campaign.
      metrics: [
        { campaign_id: 'c1', replies_human: 3 },
        { campaign_id: 'c1', replies_human: 4 },
        { campaign_id: 'c2', replies_human: 5 },
      ],
      costs: [{ entity_ref: 'idea-a', amount_usd: 25 }],
    })

    const data = await call()
    const idea = data.ideas[0]
    expect(idea.replies).toBe(12)
    expect(idea.spend_usd).toBe(25)
    // 25 / 12 = 2.0833... -> 2.08, recomputed from the raw sums
    expect(idea.cost_per_reply_usd).toBe(2.08)
  })

  it('reports null replies for an idea with no metric rows, never 0', async () => {
    seed({
      ideas: [{ id: 'idea-b', title: 'Beta', status: 'active' }],
      campaigns: [{ id: 'c9', idea_id: 'idea-b' }],
      metrics: [],
      costs: [],
    })

    const data = await call()
    const idea = data.ideas[0]
    expect(idea.replies).toBeNull()
    expect(idea.spend_usd).toBeNull()
    expect(idea.cost_per_reply_usd).toBeNull()
  })

  it('reports null replies when no replies_human value is a number', async () => {
    seed({
      ideas: [{ id: 'idea-c', title: 'Gamma', status: 'active' }],
      campaigns: [{ id: 'c3', idea_id: 'idea-c' }],
      metrics: [
        { campaign_id: 'c3', replies_human: null },
        { campaign_id: 'c3', replies_human: '5' },
      ],
      costs: [{ entity_ref: 'idea-c', amount_usd: 10 }],
    })

    const data = await call()
    const idea = data.ideas[0]
    // A string "5" is not a measurement the collector wrote; summing
    // it would invent a figure.
    expect(idea.replies).toBeNull()
    expect(idea.cost_per_reply_usd).toBeNull()
  })

  it('attributes spend only through a recognised entity_ref', async () => {
    seed({
      ideas: [
        { id: 'idea-a', title: 'Alpha', status: 'active' },
        { id: 'idea-b', title: 'Beta', status: 'active' },
      ],
      campaigns: [],
      metrics: [],
      costs: [
        { entity_ref: 'idea-a', amount_usd: 10 },
        { entity_ref: 'idea-a', amount_usd: 15 },
        // An id that is not any idea's, and a row with no ref at
        // all: neither can be attributed, so neither is added.
        { entity_ref: 'idea-zzz', amount_usd: 999 },
        { entity_ref: null, amount_usd: 500 },
      ],
    })

    const data = await call()
    const byId = new Map(data.ideas.map((i) => [i.idea_id, i]))
    expect(byId.get('idea-a')?.spend_usd).toBe(25)
    expect(byId.get('idea-b')?.spend_usd).toBeNull()
  })

  it('keeps meetings and customers null, with their derived rates null', async () => {
    seed({
      ideas: [{ id: 'idea-a', title: 'Alpha', status: 'active' }],
      campaigns: [{ id: 'c1', idea_id: 'idea-a' }],
      metrics: [{ campaign_id: 'c1', replies_human: 2 }],
      costs: [{ entity_ref: 'idea-a', amount_usd: 100 }],
    })

    const data = await call()
    const idea = data.ideas[0]
    // No collector has ever written a meeting or customer stage.
    expect(idea.meetings).toBeNull()
    expect(idea.customers).toBeNull()
    expect(idea.meetings_per_100_usd).toBeNull()
    expect(idea.cost_per_meeting_usd).toBeNull()
    expect(idea.cost_per_customer_usd).toBeNull()
  })

  it('returns 500 when the ideas query fails', async () => {
    fixtures['ideas'] = { data: null, error: { code: '42P01' } }
    fixtures['campaigns'] = { data: [] }
    fixtures['daily_metrics'] = { data: [] }
    fixtures['costs'] = { data: [] }

    const request = new NextRequest(
      new URL('/api/ideas/performance', 'http://localhost'),
    )
    const response = await performanceGET(request)
    expect(response.status).toBe(500)
  })

  it('echoes the requested range', async () => {
    seed({
      ideas: [{ id: 'idea-a', title: 'Alpha', status: 'active' }],
      campaigns: [],
      metrics: [],
      costs: [],
    })

    const request = new NextRequest(
      new URL('/api/ideas/performance?range=7d', 'http://localhost'),
    )
    const data = await performanceGET(request).then((r) => r.json())
    expect(data.range).toBe('7d')
  })
})
