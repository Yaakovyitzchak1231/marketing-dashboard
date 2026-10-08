import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWeeklyReport, weeklyMarkdown } from '@/lib/reports/weekly'
import type { DashboardData } from '@/lib/dashboard/types'
import type { CampaignMeta } from '@/lib/reports/meta'
import { campaign, counts } from './helpers/report-fixtures'

const sample = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'dashboard.sample.json'), 'utf8')) as DashboardData

function week(p: Partial<DashboardData> = {}): DashboardData {
  return {
    ...sample,
    range: { key: '7d', start: '2026-10-02', end: '2026-10-08', timezone: 'America/New_York' },
    totals: { counts: counts({ sent: 1200, contacted: 400, replied: 8, positive: 2, meetingsBooked: 1, bounced: 6 }), rates: sample.totals.rates },
    previous: { counts: counts({ sent: 1000, contacted: 350, replied: 3, positive: null, meetingsBooked: null, bounced: 9 }), rates: sample.totals.rates },
    campaigns: [
      campaign('a', { name: 'Segment 3 Cashback', leadsRemaining: 120, c: { sent: 900, contacted: 300, replied: 7, positive: 2, meetingsBooked: 1 } }),
      campaign('b', { name: 'Segment 1 Held Payouts', leadsRemaining: 2000, c: { sent: 300, contacted: 100, replied: 1, positive: 0, meetingsBooked: 0 } }),
    ],
    repliedLeads: [
      { email: 'jo@gem.com', name: 'Jo', company: 'Gem Co', campaignId: 'a', campaignName: 'Segment 3 Cashback', interest: 'interested', lastReplyAt: null, lastReplySnippet: null, awaitingOurReply: true, daysWaiting: 2 },
      { email: 'old@x.com', name: null, company: null, campaignId: 'a', campaignName: null, interest: 'unlabeled', lastReplyAt: null, lastReplySnippet: null, awaitingOurReply: false, daysWaiting: null },
    ],
    errors: [],
    ...p,
  }
}

const meta = new Map<string, CampaignMeta>([
  ['a', { campaign_id: 'a', campaign_name: null, segment: 'jeweler', angle: 'Cashback', updated_by: 'owner', updated_at: '' }],
  ['b', { campaign_id: 'b', campaign_name: null, segment: 'jeweler', angle: 'Held payouts', updated_by: 'owner', updated_at: '' }],
])

describe('weekly one-pager', () => {
  it('carries this week and last week straight from Instantly, rates recomputed', () => {
    const r = buildWeeklyReport({ data: week(), meta, pools: [{ segment: 'jeweler', ready: 30, unverified: 500 }], tasks: [], approvals: [], dbConfigured: true, windowDays: 7 })
    expect(r.thisWeek).toMatchObject({ sent: 1200, contacted: 400, replied: 8, interested: 2, meetings: 1, bounced: 6 })
    expect(r.thisWeek.replyRate).toBeCloseTo(0.02)
    expect(r.thisWeek.bounceRate).toBeCloseTo(0.005)
    expect(r.lastWeek?.meetings).toBeNull()
    expect(r.lastWeek?.interested).toBeNull()
  })

  it('names best and worst angle, and flags low runway as open items', () => {
    const r = buildWeeklyReport({
      data: week(),
      meta,
      pools: [{ segment: 'jeweler', ready: 30, unverified: 500 }],
      tasks: [{ id: 9, title: 'Fix 6 company names', status: 'blocked', kind: 'general', assigned_to: 'hermes', claimed_by: null }],
      approvals: [{ id: 3, summary: 'Verify 120 emails ($0.36)' }],
      dbConfigured: true,
      windowDays: 7,
    })
    expect(r.best?.label).toBe('Cashback')
    expect(r.worst?.label).toBe('Held payouts')
    // Cashback: 120 left at 300/7 a day = 2.8 days -> low
    const kinds = r.openItems.map((i) => i.kind)
    expect(kinds).toContain('runway')
    expect(kinds).toContain('reply')
    expect(kinds).toContain('approval')
    expect(kinds).toContain('task')
    expect(r.openItems.filter((i) => i.kind === 'reply')).toHaveLength(1)
    expect(r.openItems.find((i) => i.kind === 'task')?.taskId).toBe(9)
  })

  it('says so when Instantly or the database are not connected, and prints "no data" in markdown', () => {
    const r = buildWeeklyReport({
      data: { ...week(), configured: false, totals: { counts: counts(), rates: sample.totals.rates }, previous: null, campaigns: [], repliedLeads: [] },
      meta: new Map(),
      pools: null,
      tasks: null,
      approvals: null,
      dbConfigured: false,
    })
    expect(r.errors.join(' ')).toMatch(/Instantly is not connected/)
    expect(r.errors.join(' ')).toMatch(/lead database is not connected/)
    expect(r.best).toBeNull()
    const md = weeklyMarkdown(r)
    expect(md).toMatch(/\| Emails sent \| no data \| no data \|/)
    expect(md).toMatch(/Nothing open\./)
    expect(md).not.toMatch(/\| 0 \|/)
  })

  it('renders markdown an agent can paste', () => {
    const r = buildWeeklyReport({ data: week(), meta, pools: [], tasks: [], approvals: [], dbConfigured: true, windowDays: 7 })
    const md = weeklyMarkdown(r)
    expect(md).toMatch(/^# Weekly one-pager: 2026-10-02 to 2026-10-08/)
    expect(md).toMatch(/\| Emails sent \| 1,200 \| 1,000 \|/)
    expect(md).toMatch(/Best: \*\*Cashback\*\*/)
    expect(md).toMatch(/- \[ \] Reply waiting: Jo \(Gem Co\)/)
  })
})
