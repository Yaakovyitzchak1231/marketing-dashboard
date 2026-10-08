import { describe, expect, it } from 'vitest'
import { computeInsights, severityLabel, SEVERITY_ORDER } from '@/lib/insights'
import type { Insight } from '@/lib/dashboard/types'
import { account, campaign, day, input, lead, step, totals } from '../fixtures/insights/builders'
import { realShaped30d } from '../fixtures/insights/real-shaped-30d'

/** Every rule has something to say here. */
const kitchenSink = input({
  totals: totals({ sent: 5000, contacted: 1500, replied: 45, positive: 10, bounced: 160, opened: null }),
  previous: totals({ sent: 12000, contacted: 1500, replied: 90, positive: 30, bounced: 100 }),
  daily: [day('2026-10-03', 400), day('2026-10-04', 380), day('2026-10-05', 0), day('2026-10-06', 0), day('2026-10-07', 0), day('2026-10-08', 0)],
  campaigns: [
    campaign('good', { name: 'Good', counts: { sent: 2500, contacted: 1000, replied: 40, positive: 9, autoReplies: 3 }, leadsRemaining: 20,
      steps: [
        step({ step: 1, variant: 'A', subject: 'old line', sent: 600, replied: 8 }),
        step({ step: 1, variant: 'B', subject: 'new line', sent: 600, replied: 26 }),
        step({ step: 2, variant: 'A', sent: 700, replied: 6 }),
        step({ step: 3, variant: 'A', sent: 600, replied: 0 }),
      ],
      lifetime: { contacted: 3000, replied: 150, positive: 30 } }),
    campaign('bad', { name: 'Bad', counts: { sent: 1500, contacted: 400, replied: 2, positive: 0 }, leadsRemaining: 0, leadsTotal: 400,
      lifetime: { contacted: 400, replied: 2, positive: 0 } }),
    campaign('zero', { name: 'Zero', counts: { sent: 600, contacted: 200, replied: 0, positive: 0 } }),
    campaign('err', { name: 'Broken', status: 'error', counts: { sent: 0, contacted: 0 }, leadsRemaining: 500 }),
    campaign('old', { name: 'Old winner', status: 'completed', counts: { sent: 0, contacted: 0, replied: 0 },
      lifetime: { contacted: 8000, replied: 300, positive: 200 } }),
    campaign('tiny', { name: 'Tiny', counts: { sent: 40, contacted: 20, replied: 3 } }),
  ],
  accounts: [
    account('a@x.test', { sent: 1000, bounced: 80, warmupScore: 95 }),
    account('b@x.test', { sent: 400, bounced: 10, warmupScore: 85 }),
    account('c@x.test', { sent: 300, bounced: 2, warmupScore: 60 }),
    account('d@x.test', { status: 'connection_error' }),
    account('e@x.test', { status: 'paused', warmupScore: 100 }),
    account('f@x.test', { sent: 0, warmupScore: 100 }),
  ],
  repliedLeads: [
    lead('dana@acme.test', { name: 'Dana Lee', company: 'Acme', daysWaiting: 4 }),
    lead('sam@b.test', { name: 'Sam', interest: 'meeting_booked', daysWaiting: 0.2 }),
    lead('who@c.test', { interest: 'unlabeled', daysWaiting: 1 }),
  ],
})

const BAD_TEXT = /NaN|undefined|Infinity|null|\[object/

function checkShape(list: Insight[]) {
  const ids = new Set<string>()
  for (const i of list) {
    expect(ids.has(i.id), `duplicate id ${i.id}`).toBe(false)
    ids.add(i.id)
    expect(SEVERITY_ORDER).toContain(i.severity)
    for (const f of [i.title, i.detail, i.action]) {
      expect(f.trim().length).toBeGreaterThan(0)
      expect(f, `${i.id}: ${f}`).not.toMatch(BAD_TEXT)
    }
    if (i.metric) expect(i.metric.value).not.toMatch(BAD_TEXT)
    expect(Object.keys(i)).not.toContain('impact')
    expect(`${i.title} ${i.detail}`.replace('(not a 0% open rate)', '').toLowerCase()).not.toMatch(/0% open|open rate (is|of) 0/)
  }
}

describe('computeInsights', () => {
  it('returns [] when not configured, even with data', () => {
    expect(computeInsights({ ...kitchenSink, configured: false })).toEqual([])
  })

  it('returns [] with no data at all (no fake cards)', () => {
    expect(computeInsights(input())).toEqual([])
    expect(computeInsights(input({ totals: totals({ sent: 0, contacted: 0, replied: 0 }) }))).toEqual([])
  })

  it('fires every rule family on the kitchen-sink fixture', () => {
    const ids = computeInsights(kitchenSink).map((i) => i.id)
    for (const expected of [
      'lead-waiting:dana@acme.test', 'lead-waiting:sam@b.test', 'replies-unlabeled',
      'bounce-total', 'bounce-at_risk:a@x.test', 'bounce-watch:b@x.test', 'account-error:d@x.test',
      'warmup-at_risk:c@x.test', 'warmup-watch:b@x.test', 'account-paused:e@x.test', 'accounts-idle',
      'campaign-gap:bad', 'campaign-best:good', 'campaign-vs-history:bad', 'campaigns-stopped-winners',
      'campaign-zero-replies:zero', 'campaign-error:err', 'campaign-out-of-leads:bad', 'campaign-low-runway:good',
      'variant-winner:good:1', 'step-dead:good:3', 'step-mix', 'subject-best:good:1:B',
      'trend-reply-down', 'trend-positive-down', 'trend-volume-down', 'sending-stalled',
    ]) expect(ids, expected).toContain(expected)
  })

  it('ranks critical, warning, opportunity, win', () => {
    const sev = computeInsights(kitchenSink).map((i) => SEVERITY_ORDER.indexOf(i.severity))
    expect([...sev].sort((a, b) => a - b)).toEqual(sev)
    const first = computeInsights(kitchenSink)[0]
    expect(first.id).toBe('lead-waiting:dana@acme.test') // a hot lead waiting 4 days outranks everything
  })

  it('is deterministic and independent of input order', () => {
    const a = computeInsights(kitchenSink)
    const shuffled = {
      ...kitchenSink,
      campaigns: [...kitchenSink.campaigns].reverse().map((c) => ({ ...c, steps: [...c.steps].reverse() })),
      accounts: [...kitchenSink.accounts].reverse(),
      repliedLeads: [...kitchenSink.repliedLeads].reverse(),
      daily: [...kitchenSink.daily].reverse(),
    }
    expect(computeInsights(shuffled)).toEqual(a)
    expect(computeInsights(kitchenSink)).toEqual(a)
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(kitchenSink)
    computeInsights(kitchenSink)
    expect(JSON.stringify(kitchenSink)).toBe(before)
  })

  it('every card is well-formed: numbers, an action, no NaN/undefined, no 0% open rate', () => {
    checkShape(computeInsights(kitchenSink))
    checkShape(computeInsights(realShaped30d))
  })

  it('says "open tracking is off" exactly once, inside a campaign card, never as its own card', () => {
    const list = computeInsights(kitchenSink)
    const withNote = list.filter((i) => i.detail.includes('Open tracking is off'))
    expect(withNote).toHaveLength(1)
    expect(withNote[0].id).toBe('campaign-vs-history:bad')
    expect(list.some((i) => /open/i.test(i.title))).toBe(false)
  })

  it('no tracking note when tracking is on', () => {
    const on = { ...kitchenSink, campaigns: kitchenSink.campaigns.map((c) => ({ ...c, openTracking: true })), totals: totals({ ...kitchenSink.totals.counts, opened: 300 }) }
    expect(computeInsights(on).some((i) => i.detail.includes('Open tracking is off'))).toBe(false)
  })

  it("real 30-day shape: tells him the truth about his account", () => {
    const list = computeInsights(realShaped30d)
    expect(list.map((i) => [i.severity, i.id])).toEqual([
      ['warning', 'campaign-vs-history:c-test'],
      ['warning', 'campaign-zero-replies:c-seg3'],
      ['opportunity', 'campaigns-stopped-winners'],
      ['opportunity', 'step-dead:c-test:4'],
      ['opportunity', 'campaign-low-runway:c-seg3'], // 1 lead left at 7/day runs out first
      ['opportunity', 'campaign-low-runway:c-test'],
    ])
    // the 30d bounce (6 of 2,618) and two healthy inboxes produce no deliverability noise
    expect(list.some((i) => i.id.startsWith('bounce') || i.id.startsWith('account'))).toBe(false)
  })

  it('handles a data layer that partly failed (nulls everywhere) without inventing anything', () => {
    const partial = input({
      totals: totals({ sent: 900 }),
      campaigns: [campaign('x', { counts: { sent: 900 }, steps: [] })],
      accounts: [account('a@x.test', {})],
      errors: [{ source: 'campaigns/analytics', message: 'Instantly timed out' }],
    })
    expect(computeInsights(partial)).toEqual([])
  })
})

describe('severityLabel', () => {
  it('has a short label for each severity', () => {
    expect(SEVERITY_ORDER.map(severityLabel)).toEqual(['Act now', 'Needs attention', 'Opportunity', 'Working'])
  })
})
