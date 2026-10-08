import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
import { getDashboardData } from '@/lib/dashboard/load'
import { InstantlyClient, clearInstantlyMemo } from '@/lib/instantly/client'
import { fakeInstantly, type Override, C1, C2, C3 } from './helpers/instantly-fake'

const KEY = 'fake-key-DO-NOT-LEAK-987654'
const NOW = new Date('2026-10-08T16:00:00Z') // 12:00 in New York
const TZ = 'America/New_York'

function setup(override?: Override) {
  const fake = fakeInstantly(override)
  const client = new InstantlyClient({ apiKey: KEY, fetchImpl: fake.fetchImpl, backoffMs: 0, retries: 1, memoTtlMs: 0, sleep: async () => {} })
  return { ...fake, client }
}

beforeEach(() => clearInstantlyMemo())

describe('getDashboardData', () => {
  it('not configured: configured:false, empty data and ZERO network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const d = await getDashboardData('30d', { client: null, now: NOW, timeZone: TZ })
    expect(d.configured).toBe(false)
    expect(d.campaigns).toEqual([])
    expect(d.totals.counts.sent).toBeNull()
    expect(d.range).toEqual({ key: '30d', start: '2026-09-09', end: '2026-10-08', timezone: TZ })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('maps a full 30-day load to the contract', async () => {
    const { client, calls } = setup()
    const d = await getDashboardData('30d', { client, now: NOW, timeZone: TZ })
    expect(d.configured).toBe(true)
    expect(d.errors).toEqual([])
    expect(d.generatedAt).toBe(NOW.toISOString())

    // Totals from the overview for exactly the range's calendar days.
    const ovCall = calls.find((c) => c.path === '/campaigns/analytics/overview' && !c.query.get('id') && c.query.get('start_date') === '2026-09-09')
    expect(ovCall?.query.get('end_date')).toBe('2026-10-08')
    expect(d.totals.counts).toEqual({
      sent: 2618, contacted: 705, opened: null, clicked: null, replied: 10, autoReplies: 11,
      bounced: 6, unsubscribed: 0, positive: 2, meetingsBooked: 1, opportunityValue: 2000,
    })
    expect(d.totals.rates.replyRate).toBeCloseTo(10 / 705, 10)
    expect(d.totals.rates.openRate).toBeNull() // tracking off on every campaign that sent

    // Previous period: the 30 days before, for deltas.
    const prevCall = calls.find((c) => c.path === '/campaigns/analytics/overview' && c.query.get('start_date') === '2026-08-10')
    expect(prevCall?.query.get('end_date')).toBe('2026-09-08')
    expect(d.previous?.counts.sent).toBe(1500)
    expect(d.previous?.rates.replyRate).toBeCloseTo(8 / 600, 10)

    // Campaigns: all three, across two list pages, busiest first.
    expect(d.campaigns.map((c) => c.id)).toEqual([C1, C2, C3])
    const [c1, c2, c3] = d.campaigns
    expect(c1).toMatchObject({ name: 'Jewelers - Test 01', status: 'active', openTracking: false, leadsTotal: 495, leadsRemaining: 0 })
    expect(c1.counts).toMatchObject({ sent: 2408, contacted: 495, replied: 10, autoReplies: 11, bounced: 5, meetingsBooked: 1, opened: null })
    expect(c1.rates.replyRate).toBeCloseTo(10 / 495, 10)
    expect(c1.steps.map((s) => `${s.step}${s.variant}`)).toEqual(['1A', '1B', '2A'])
    expect(c1.lifetime?.counts.sent).toBe(2408)
    expect(c2.counts.bounced).toBe(1)
    // C3 had no activity in the range: measured zeros (opens tracked -> 0), lifetime still shown, no per-campaign calls.
    expect(c3).toMatchObject({ status: 'completed', openTracking: true, leadsTotal: 12000, leadsRemaining: 254, steps: [] })
    expect(c3.counts).toMatchObject({ sent: 0, contacted: 0, replied: 0, opened: 0, meetingsBooked: 0 })
    expect(c3.rates.replyRate).toBeNull()
    expect(c3.lifetime?.counts).toMatchObject({ sent: 31893, contacted: 11746, replied: 1357, positive: 951 })
    expect(calls.some((c) => c.path === '/campaigns/analytics/steps' && c.query.get('campaign_id') === C3)).toBe(false)

    // Daily: one point per calendar day, omitted days = 0, no invented bounces.
    expect(d.daily).toHaveLength(30)
    expect(d.daily[0]).toEqual({ date: '2026-09-09', sent: 54, contacted: 54, replied: 1, positive: 0, bounced: null, opened: null })
    expect(d.daily.find((p) => p.date === '2026-09-20')?.sent).toBe(0)
    expect(d.daily.reduce((a, p) => a + (p.sent ?? 0), 0)).toBe(54 + 54 + 162)

    // Sending accounts: both pages, per-inbox numbers from the daily account endpoint with an emails filter.
    const accCall = calls.find((c) => c.path === '/accounts/analytics/daily')
    expect(accCall?.query.get('emails')).toBe('sam@sender-one.example,sam@sender-two.example,sam@sender-three.example')
    expect(accCall?.query.get('start_date')).toBe('2026-09-09')
    expect(d.accounts.map((a) => [a.email, a.status, a.sent, a.bounced, a.warmupScore, a.dailyLimit])).toEqual([
      ['sam@sender-one.example', 'active', 50, 1, 100, 30],
      ['sam@sender-two.example', 'soft bounce error', 25, 2, null, 30],
      ['sam@sender-three.example', 'paused', 0, 0, 88, null],
    ])
    expect(d.accounts[1].bounceRate).toBeCloseTo(2 / 25, 10)
    expect(d.accounts[2].bounceRate).toBeNull()
    for (const a of d.accounts) {
      expect(typeof a.health).toBe('string')
      expect(typeof a.healthReason).toBe('string')
    }

    // Replies: real lead replies in range only.
    expect(d.repliedLeads.map((l) => [l.email, l.awaitingOurReply, l.campaignName])).toEqual([
      ['ann@shop-a.example', true, 'Jewelers - Test 01'],
      ['bob@shop-b.example', false, 'Jewelers - Test 01'],
    ])

    // Read-only: GETs plus the one read-only list POST, every call authenticated.
    expect(calls.every((c) => c.method === 'GET' || c.path === '/leads/list')).toBe(true)
    expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true)
    expect(JSON.stringify(d)).not.toContain(KEY)
  })

  it('a failing source becomes an error; everything else still loads and nothing turns into 0', async () => {
    const { client } = setup((c) => {
      if (c.path === '/campaigns/analytics/steps' && c.query.get('campaign_id') === C2) return new Response('{}', { status: 500 })
      if (c.path === '/campaigns/analytics/daily') return new Response(JSON.stringify({ message: 'nope' }), { status: 400 })
      if (c.path === '/accounts/analytics/daily') return new Response(JSON.stringify({ message: `bad ${KEY}` }), { status: 401 })
      return undefined
    })
    const d = await getDashboardData('30d', { client, now: NOW, timeZone: TZ })
    const sources = d.errors.map((e) => e.source)
    expect(sources).toEqual(expect.arrayContaining(['campaigns/analytics/daily', 'campaigns/analytics/steps', 'accounts/analytics/daily']))
    expect(d.campaigns.find((c) => c.id === C2)?.steps).toEqual([])
    expect(d.campaigns.find((c) => c.id === C1)?.steps).toHaveLength(3)
    expect(d.daily.every((p) => p.sent === null)).toBe(true)
    expect(d.accounts.every((a) => a.sent === null && a.bounced === null && a.bounceRate === null)).toBe(true)
    expect(d.totals.counts.sent).toBe(2618)
    expect(JSON.stringify(d)).not.toContain(KEY)
  })

  it('when the range analytics call fails, campaign counts are null (not zero)', async () => {
    const { client } = setup((c) => (c.path === '/campaigns/analytics' && c.query.get('start_date') ? new Response('{}', { status: 503 }) : undefined))
    const d = await getDashboardData('30d', { client, now: NOW, timeZone: TZ })
    expect(d.errors.map((e) => e.source)).toContain('campaigns/analytics')
    const c3 = d.campaigns.find((c) => c.id === C3)!
    expect(c3.counts.sent).toBeNull()
    expect(c3.lifetime?.counts.sent).toBe(31893)
  })

  it('explains, instead of showing >100%, when replies outnumber new leads in a short range', async () => {
    const { client } = setup((c) =>
      c.path === '/campaigns/analytics/overview' && !c.query.get('id') && c.query.get('start_date') === '2026-10-02'
        ? new Response(JSON.stringify({ emails_sent_count: 300, new_leads_contacted_count: 2, reply_count_unique: 5 }), { status: 200 })
        : undefined,
    )
    const d = await getDashboardData('7d', { client, now: NOW, timeZone: TZ })
    expect(d.range).toMatchObject({ start: '2026-10-02', end: '2026-10-08' })
    expect(d.totals.rates.replyRate).toBeNull()
    expect(d.errors.find((e) => e.source === 'reply rate')?.message).toMatch(/5 people replied but only 2 new leads/)
  })

  it('all-time: no dates sent, no previous period, daily from the first campaign', async () => {
    const { client, calls } = setup()
    const d = await getDashboardData('all', { client, now: NOW, timeZone: TZ })
    expect(d.range.start).toBeNull()
    expect(d.previous).toBeNull()
    const ov = calls.find((c) => c.path === '/campaigns/analytics/overview' && !c.query.get('id'))
    expect(ov?.query.get('start_date')).toBeNull()
    expect(d.daily[0].date).toBe('2026-05-19')
    expect(d.daily.at(-1)?.date).toBe('2026-10-08')
    // Per-inbox history is fetched in <=31-day windows.
    const windows = calls.filter((c) => c.path === '/accounts/analytics/daily').map((c) => [c.query.get('start_date'), c.query.get('end_date')])
    expect(windows[0]).toEqual(['2026-05-19', '2026-06-18'])
    expect(windows.at(-1)?.[1]).toBe('2026-10-08')
    expect(d.repliedLeads.map((l) => l.email)).toContain('old@shop-d.example')
  })

  it('splits the per-inbox request when Instantly says it is too large (413)', async () => {
    const { client, calls } = setup((c) =>
      c.path === '/accounts/analytics/daily' && (c.query.get('emails') ?? '').split(',').length > 1
        ? new Response(JSON.stringify({ message: 'Analytics request is too large for this workspace.' }), { status: 413 })
        : undefined,
    )
    const d = await getDashboardData('30d', { client, now: NOW, timeZone: TZ })
    expect(d.accounts.find((a) => a.email === 'sam@sender-one.example')?.sent).toBe(50)
    expect(calls.filter((c) => c.path === '/accounts/analytics/daily').length).toBeGreaterThan(3)
    expect(d.errors).toEqual([])
  })
})
