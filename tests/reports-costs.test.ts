import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  bestWorst, buildCostReport, daysInMonth, deleteCost, listCosts, overlapDays, parseMonth, prorate, upsertCost, verificationSpend,
  type CostRow,
} from '@/lib/reports/costs'
import type { CampaignMeta } from '@/lib/reports/meta'
import { campaign } from './helpers/report-fixtures'
import { createTestDb } from './helpers/pglite-db'

const meta = (pairs: [string, string | null][]) =>
  new Map<string, CampaignMeta>(pairs.map(([id, angle]) => [id, { campaign_id: id, campaign_name: null, segment: 'jeweler', angle, updated_by: 'owner', updated_at: '' }]))
const cost = (p: Partial<CostRow>): CostRow => ({ id: 1, month: '2026-10-01', category: 'inboxes', label: 'x', amount_usd: 0, campaign_id: null, notes: null, ...p })

describe('proration', () => {
  it('splits a monthly amount by day across the range', () => {
    expect(daysInMonth('2026-02-01')).toBe(28)
    expect(daysInMonth('2026-10-01')).toBe(31)
    expect(overlapDays('2026-10-01', { start: '2026-09-09', end: '2026-10-08' })).toBe(8)
    expect(overlapDays('2026-09-01', { start: '2026-09-09', end: '2026-10-08' })).toBe(22)
    expect(overlapDays('2026-08-01', { start: '2026-09-09', end: '2026-10-08' })).toBe(0)
    expect(prorate({ month: '2026-09-01', amount_usd: 300 }, { start: '2026-09-01', end: '2026-09-30' })).toBe(300)
    expect(prorate({ month: '2026-09-01', amount_usd: 300 }, { start: '2026-09-09', end: '2026-10-08' })).toBeCloseTo(220)
  })

  it('parses months strictly', () => {
    expect(parseMonth('2026-10')).toBe('2026-10-01')
    expect(parseMonth('2026-10-17')).toBe('2026-10-01')
    expect(parseMonth('2026-13')).toBeNull()
    expect(parseMonth('Oct')).toBeNull()
  })
})

describe('cost report', () => {
  const span = { start: '2026-10-01', end: '2026-10-31' }
  const cs = [
    campaign('a', { name: 'A', c: { sent: 3000, contacted: 1000, replied: 20, positive: 4, meetingsBooked: 2 } }),
    campaign('b', { name: 'B', c: { sent: 1000, contacted: 400, replied: 4, positive: 0, meetingsBooked: 0 } }),
    campaign('c', { name: 'C', c: { sent: 0, contacted: 0, replied: 0, positive: null, meetingsBooked: null } }),
  ]

  it('direct costs go to their campaign; shared costs split by emails sent', () => {
    const r = buildCostReport(cs, [cost({ amount_usd: 400 }), cost({ id: 2, label: 'y', amount_usd: 100, campaign_id: 'b' })], meta([]), span)
    const [a, b, c] = r.campaigns
    expect(a.cost).toBeCloseTo(300)
    expect(b.cost).toBeCloseTo(200) // 100 direct + 100 share
    expect(c.cost).toBe(0)
    expect(a.costPerMeeting).toBeCloseTo(150)
    expect(a.costPerReply).toBeCloseTo(15)
    expect(a.replyRate).toBeCloseTo(0.02)
    expect(b.costPerMeeting).toBeNull() // zero meetings: nothing to divide by
    expect(c.costPerMeeting).toBeNull() // meetings not reported
    expect(c.meetings).toBeNull()
    expect(r.totalCost).toBeCloseTo(500)
    expect(a.includesShared).toBe(true)
  })

  it('no cost rows -> cost is no data, never $0', () => {
    const r = buildCostReport(cs, [], meta([]), span)
    expect(r.totalCost).toBeNull()
    expect(r.campaigns.every((l) => l.cost === null && l.costPerMeeting === null)).toBe(true)
  })

  it('shared cost with nothing sent stays unallocated', () => {
    const r = buildCostReport([cs[2]], [cost({ amount_usd: 310 })], meta([]), span)
    expect(r.unallocatedShared).toBeCloseTo(310)
  })

  it('a cost tied to a campaign not in the list is counted in the total and reported', () => {
    const r = buildCostReport(cs, [cost({ amount_usd: 31, campaign_id: 'gone' })], meta([]), span)
    expect(r.directCostUnknownCampaign).toBeCloseTo(31)
    expect(r.totalCost).toBeCloseTo(31)
  })

  it('groups by angle with recomputed rates and null-aware sums', () => {
    const r = buildCostReport(cs, [], meta([['a', 'Held payouts'], ['b', 'held payouts'], ['c', 'Cashback']]), span)
    const held = r.angles.find((l) => l.key === 'held payouts')!
    expect(held.contacted).toBe(1400)
    expect(held.replied).toBe(24)
    expect(held.replyRate).toBeCloseTo(24 / 1400)
    const cash = r.angles.find((l) => l.key === 'cashback')!
    expect(cash.meetings).toBeNull()
    expect(cash.replyRate).toBeNull() // 0 contacted: no rate
    const r2 = buildCostReport(cs, [], meta([['a', 'X'], ['c', 'X']]), span)
    const x = r2.angles.find((l) => l.key === 'x')!
    expect(x.meetings).toBe(2)
    expect(x.partial).toBe(true)
    expect(r2.angles.at(-1)!.label).toBe('Angle not set')
  })

  it('best/worst only among angles with enough contacted leads', () => {
    const r = buildCostReport(cs, [], meta([['a', 'Held'], ['b', 'Custom'], ['c', 'Cash']]), span)
    const bw = bestWorst(r.angles)
    expect(bw.best?.label).toBe('Held')
    expect(bw.worst?.label).toBe('Custom')
    expect(bw.ranked).toBe(2)
    expect(bestWorst(r.angles, 5000).best).toBeNull()
  })
})

describe('cost table storage', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('upserts by month + category + label + campaign, lists by span, deletes', async () => {
    const a = await upsertCost(db, 'owner', { month: '2026-10', category: 'inboxes', label: '27 inboxes', amount_usd: 81 })
    await upsertCost(db, 'owner', { month: '2026-10', category: 'inboxes', label: '27 inboxes', amount_usd: 90.555 })
    await upsertCost(db, 'owner', { month: '2026-09', category: 'tools', label: 'Instantly', amount_usd: 97, campaign_id: null })
    await upsertCost(db, 'owner', { month: '2026-10', category: 'verification', label: 'MV', amount_usd: 12, campaign_id: 'cmp-a' })
    const all = await listCosts(db)
    expect(all).toHaveLength(3)
    expect(all.find((c) => c.label === '27 inboxes')!.amount_usd).toBe(90.56)
    const oct = await listCosts(db, { start: '2026-10-01', end: '2026-10-08' })
    expect(oct.map((c) => c.label).sort()).toEqual(['27 inboxes', 'MV'])
    expect(await deleteCost(db, a.id)).toBe(true)
    expect(await listCosts(db)).toHaveLength(2)
  })

  it('rejects bad input in plain words', async () => {
    await expect(upsertCost(db, 'owner', { month: 'soon', category: 'tools', label: 'x', amount_usd: 1 })).rejects.toThrow(/Month/)
    await expect(upsertCost(db, 'owner', { month: '2026-10', category: 'snacks', label: 'x', amount_usd: 1 })).rejects.toThrow(/category/)
    await expect(upsertCost(db, 'owner', { month: '2026-10', category: 'tools', label: ' ', amount_usd: 1 })).rejects.toThrow(/name/)
    await expect(upsertCost(db, 'owner', { month: '2026-10', category: 'tools', label: 'x', amount_usd: -5 })).rejects.toThrow(/Amount/)
  })

  it('reads measured verification spend from verification runs', async () => {
    await db.query(
      `insert into lp.verification_runs (status, contact_ids, contact_count, spent_usd, created_at, finished_at) values
       ('done', '{1}', 1, 2.50, '2026-10-03', '2026-10-03'), ('done', '{2}', 1, 1.25, '2026-09-03', '2026-09-03')`,
    )
    expect(await verificationSpend(db, { start: '2026-10-01', end: '2026-10-31' })).toBeCloseTo(2.5)
    expect(await verificationSpend(db, { start: '2026-11-01', end: '2026-11-30' })).toBe(0)
  })
})
