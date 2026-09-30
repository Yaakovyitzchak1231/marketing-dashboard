import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as overviewGET } from '@/app/api/overview/route'
import { GET as campaignsGET } from '@/app/api/campaigns/route'
import { GET as trendGET } from '@/app/api/campaigns/[id]/trend/route'

const mockSupabase = vi.hoisted(() => ({
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ supabase: mockSupabase }))

const ACCOUNT = {
  emails_sent: 45545,
  replies_unique: 1910,
  replies_automatic_unique: 39,
  replies_all: 2350,
  bounces: 174,
  unsubscribed: 0,
  opportunities: 1335,
  opportunity_value: 1335000,
  contacted_count: 45173,
  new_leads_contacted_count: 17376,
  opens_unique: 0,
  open_reported: false,
  unsub_reported: false,
  mailbox_count: 7,
  healthy_mailboxes: 4,
  warmup_score_avg: 85.4,
  campaigns_inventory_count: 8,
  campaigns_collected_count: 8,
  partial: false,
}

describe('API null handling', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('GET /api/overview', () => {
    it('returns null for every field when no data exists', async () => {
      mockSupabase.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })

      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()

      expect(d.emails_sent).toBeNull()
      expect(d.replies_unique).toBeNull()
      expect(d.reply_rate).toBeNull()
      expect(d.reply_rate_trusted).toBe(false)
      expect(d.open_rate).toBeNull()
      expect(d.mailbox_count).toBeNull()
      expect(d.healthy_mailboxes).toBeNull()
      // partial true on an empty response: nothing was collected.
      expect(d.partial).toBe(true)
    })

    it('never emits a replies_human field', async () => {
      mockSupabase.single.mockResolvedValue({ data: ACCOUNT, error: null })
      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()
      // The derived-human column was removed; it must not reappear at the API.
      expect(d.replies_human).toBeUndefined()
      expect('replies_human' in d).toBe(false)
      expect(d.replies_unique).toBe(1910)
      expect(d.replies_automatic_unique).toBe(39)
    })

    it('returns null open_rate and unsubscribe_rate even though the counts are 0', async () => {
      mockSupabase.single.mockResolvedValue({ data: ACCOUNT, error: null })
      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()
      // opens_unique is 0 in the payload, but Instantly never measured opens.
      expect(d.opens_unique).toBe(0)
      expect(d.open_rate).toBeNull()
      expect(d.unsubscribe_rate).toBeNull()
      expect(d.open_reported).toBe(false)
    })

    it('computes reply rate from raw counts and never averages', async () => {
      mockSupabase.single.mockResolvedValue({ data: ACCOUNT, error: null })
      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()
      expect(d.reply_rate).toBe(0.0419)
      // 1,949/45,545 (adding autoresponders) would be 0.0428 and is wrong.
      expect(d.reply_rate).not.toBe(0.0428)
      expect(d.reply_rate_trusted).toBe(true)
      expect(d.reply_rate_denominator_source).toBe('emails_sent')
    })

    it('returns null rates on zero denominator', async () => {
      mockSupabase.single.mockResolvedValue({
        data: { ...ACCOUNT, emails_sent: 0 },
        error: null,
      })
      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()
      expect(d.emails_sent).toBe(0)
      expect(d.reply_rate).toBeNull()
      expect(d.bounce_rate).toBeNull()
      expect(d.reply_rate_reason).toBe('no_sends')
    })

    it('marks a partial collection partial and does not trust its rate', async () => {
      mockSupabase.single.mockResolvedValue({
        data: { ...ACCOUNT, partial: true, campaigns_collected_count: 5 },
        error: null,
      })
      const res = await overviewGET(new Request('http://localhost/api/overview?range=7d'))
      const d = await res.json()
      expect(d.partial).toBe(true)
      expect(d.reply_rate_trusted).toBe(false)
      // Both counts survive so the UI can state the mismatch.
      expect(d.campaigns_inventory_count).toBe(8)
      expect(d.campaigns_collected_count).toBe(5)
    })
  })

  describe('GET /api/campaigns', () => {
    // `campaign` sets campaign-level columns; `metrics` sets daily_metrics
    // columns. Mixing them silently makes a test assert nothing.
    const row = (
      campaign: Record<string, unknown> = {},
      metrics: Record<string, unknown> = {}
    ) => ({
      id: 'c1',
      external_id: 'ext-1',
      name: 'PB Signups / Leads',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      ...campaign,
      daily_metrics: [{
        metric_date: '2026-09-29',
        emails_sent: 31893,
        replies_unique: 1357,
        replies_automatic_unique: 8,
        replies_all: 1696,
        bounces: 85,
        opportunities: 951,
        opens_unique: 0,
        unsubscribed: 0,
        open_reported: false,
        unsub_reported: false,
        partial: false,
        ...metrics,
      }],
    })

    it('suppresses the 450% campaign and states the reason', async () => {
      mockSupabase.limit.mockResolvedValue({
        data: [row({}, { emails_sent: 2, replies_unique: 9, replies_automatic_unique: 0 })],
        error: null,
      })
      const res = await campaignsGET(new Request('http://localhost/api/campaigns?range=7d'))
      const d = await res.json()
      const c = d.campaigns[0]
      expect(c.reply_rate).toBeNull()
      expect(c.reply_rate_trusted).toBe(false)
      expect(c.reply_rate_reason).toBe('numerator_exceeds_denominator')
      // Raw counts still present: the numbers are real, only the rate is invalid.
      expect(c.emails_sent).toBe(2)
      expect(c.replies_unique).toBe(9)
    })

    it('does not derive a human reply count from the two independent counters', async () => {
      mockSupabase.limit.mockResolvedValue({
        data: [row({}, { emails_sent: 2126, replies_unique: 8, replies_automatic_unique: 10 })],
        error: null,
      })
      const res = await campaignsGET(new Request('http://localhost/api/campaigns?range=7d'))
      const d = await res.json()
      const c = d.campaigns[0]
      expect(c.replies_unique).toBe(8)
      expect(c.replies_automatic_unique).toBe(10)
      // 8 - 10 = -2 must never appear as a count.
      expect(c.replies_human).toBeUndefined()
    })

    it('returns null for uncollected metrics instead of zero', async () => {
      mockSupabase.limit.mockResolvedValue({
        data: [row({}, {
          emails_sent: null, replies_unique: null, replies_automatic_unique: null,
          bounces: null, opportunities: null,
        })],
        error: null,
      })
      const res = await campaignsGET(new Request('http://localhost/api/campaigns?range=7d'))
      const c = (await res.json()).campaigns[0]
      expect(c.emails_sent).toBeNull()
      expect(c.replies_unique).toBeNull()
      expect(c.reply_rate).toBeNull()
      expect(c.bounce_rate).toBeNull()
      expect(c.reply_rate_reason).toBe('not_collected')
    })

    it('reports how many rows rendered so a partial run is detectable', async () => {
      mockSupabase.limit.mockResolvedValue({
        data: [row({ id: 'a' }), row({ id: 'b' })],
        error: null,
      })
      const res = await campaignsGET(new Request('http://localhost/api/campaigns?range=7d'))
      expect((await res.json()).returned).toBe(2)
    })

    it('sorts null rates last in both directions', async () => {
      mockSupabase.limit.mockResolvedValue({
        data: [
          row({ name: 'bad' }, { emails_sent: 2, replies_unique: 9 }),
          row({ name: 'good' }, { emails_sent: 31893, replies_unique: 1357 }),
        ],
        error: null,
      })
      const res = await campaignsGET(
        new Request('http://localhost/api/campaigns?sort=reply_rate&order=desc')
      )
      const names = (await res.json()).campaigns.map((c: { name: string }) => c.name)
      expect(names[names.length - 1]).toBe('bad')
    })
  })

  describe('GET /api/campaigns/[id]/trend', () => {
    it('rates each day independently and never carries a rate forward', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          id: 'c1', external_id: 'e', name: 'n', status: 'active', created_at: null,
          daily_metrics: [
            { metric_date: '2026-09-28', emails_sent: 100, replies_unique: 8,
              replies_automatic_unique: 1, replies_all: 9, bounces: 2, opportunities: 3,
              opens_unique: 0, unsubscribed: 0, open_reported: false, unsub_reported: false, partial: false },
            { metric_date: '2026-09-29', emails_sent: null, replies_unique: null,
              replies_automatic_unique: null, replies_all: null, bounces: null, opportunities: null,
              opens_unique: null, unsubscribed: null, open_reported: false, unsub_reported: false, partial: false },
          ],
        },
        error: null,
      })
      const res = await trendGET(
        new Request('http://localhost/api/campaigns/c1/trend?range=7d'),
        { params: Promise.resolve({ id: 'c1' }) }
      )
      const d = await res.json()
      expect(d.trend[0].reply_rate).toBe(0.08)
      // Day two is a gap, not a zero and not a repeat of day one.
      expect(d.trend[1].reply_rate).toBeNull()
      expect(d.trend[1].emails_sent).toBeNull()
      expect(d.trend[1].reply_rate_reason).toBe('not_collected')
      expect(d.has_gaps).toBe(true)
    })

    it('returns null open_rate on every day', async () => {
      mockSupabase.single.mockResolvedValue({
        data: {
          id: 'c1', external_id: 'e', name: 'n', status: 'active', created_at: null,
          daily_metrics: [{
            metric_date: '2026-09-29', emails_sent: 100, replies_unique: 8,
            replies_automatic_unique: 0, replies_all: 8, bounces: 1, opportunities: 1,
            opens_unique: 0, unsubscribed: 0, open_reported: false, unsub_reported: false, partial: false,
          }],
        },
        error: null,
      })
      const res = await trendGET(
        new Request('http://localhost/api/campaigns/c1/trend?range=7d'),
        { params: Promise.resolve({ id: 'c1' }) }
      )
      const d = await res.json()
      expect(d.trend[0].open_rate).toBeNull()
      expect(d.trend[0].unsubscribe_rate).toBeNull()
    })

    it('404s for a campaign that does not exist', async () => {
      mockSupabase.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
      const res = await trendGET(
        new Request('http://localhost/api/campaigns/nope/trend?range=7d'),
        { params: Promise.resolve({ id: 'nope' }) }
      )
      expect(res.status).toBe(404)
    })
  })
})
