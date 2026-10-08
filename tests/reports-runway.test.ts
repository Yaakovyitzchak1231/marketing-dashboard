import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { campaignRunway, formatDays, levelFor, segmentPools, segmentRunway, RUNWAY_WARN_DAYS } from '@/lib/reports/runway'
import type { CampaignMeta } from '@/lib/reports/meta'
import { angleHintFromName, saveCampaignMeta, listCampaignMeta, segmentHintFromName } from '@/lib/reports/meta'
import { campaign } from './helpers/report-fixtures'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'

const meta = (id: string, segment: CampaignMeta['segment'], angle: string | null = null): CampaignMeta => ({
  campaign_id: id, campaign_name: null, segment, angle, updated_by: 'owner', updated_at: '2026-10-08T00:00:00Z',
})

describe('runway levels', () => {
  it('warns under 14 days, says out at zero, never invents a pace', () => {
    expect(RUNWAY_WARN_DAYS).toBe(14)
    expect(levelFor(1400, 100)).toBe('ok')
    expect(levelFor(1300, 100)).toBe('low')
    expect(levelFor(0, 100)).toBe('out')
    expect(levelFor(500, 0)).toBe('not_sending')
    expect(levelFor(null, 100)).toBe('no_data')
    expect(levelFor(500, null)).toBe('no_data')
  })

  it('formats days honestly', () => {
    expect(formatDays(null)).toBe('no data')
    expect(formatDays(0.4)).toBe('under a day')
    expect(formatDays(1.9)).toBe('1 day')
    expect(formatDays(23.5)).toBe('23 days')
  })
})

describe('campaign runway', () => {
  it('pace = contacted in window / window days; days = remaining / pace', () => {
    const r = campaignRunway(campaign('a', { leadsRemaining: 700, c: { contacted: 350 } }), meta('a', 'jeweler', 'Held payouts'), 7)
    expect(r.pacePerDay).toBe(50)
    expect(r.days).toBe(14)
    expect(r.level).toBe('ok')
    expect(r.segment).toBe('jeweler')
    expect(r.angle).toBe('Held payouts')
  })

  it('keeps nulls null (no remaining or no contacted -> no data)', () => {
    const r = campaignRunway(campaign('a', { leadsRemaining: null, c: { contacted: 70 } }), undefined)
    expect(r.days).toBeNull()
    expect(r.level).toBe('no_data')
    const r2 = campaignRunway(campaign('b', { leadsRemaining: 500, c: { contacted: null } }), undefined)
    expect(r2.pacePerDay).toBeNull()
    expect(r2.level).toBe('no_data')
  })

  it('a paused campaign is "not sending", not a countdown', () => {
    const r = campaignRunway(campaign('p', { status: 'paused', leadsRemaining: 400, c: { contacted: 70 } }), undefined, 7)
    expect(r.level).toBe('not_sending')
    expect(r.days).toBeNull()
  })
})

describe('segment runway', () => {
  it('adds unused verified leads to loaded ones; only active campaigns set the pace', () => {
    const cs = [
      campaignRunway(campaign('a', { leadsRemaining: 100, c: { contacted: 140 } }), meta('a', 'jeweler'), 7), // 20/day
      campaignRunway(campaign('b', { status: 'paused', leadsRemaining: 60, c: { contacted: 70 } }), meta('b', 'jeweler'), 7),
      campaignRunway(campaign('c', { leadsRemaining: 999, c: { contacted: 70 } }), undefined, 7), // no segment: not counted
    ]
    const [jw] = segmentRunway([{ segment: 'jeweler', ready: 40, unverified: 300 }], cs)
    expect(jw.loadedRemaining).toBe(160)
    expect(jw.pacePerDay).toBe(20)
    expect(jw.days).toBe(10) // (40 + 160) / 20
    expect(jw.level).toBe('low')
    expect(jw.unverified).toBe(300)
  })

  it('one campaign without a remaining count makes the segment total no data, not a smaller number', () => {
    const cs = [
      campaignRunway(campaign('a', { leadsRemaining: 100, c: { contacted: 70 } }), meta('a', 'ai_agency'), 7),
      campaignRunway(campaign('b', { leadsRemaining: null, c: { contacted: 70 } }), meta('b', 'ai_agency'), 7),
    ]
    const [ai] = segmentRunway([], cs)
    expect(ai.segment).toBe('ai_agency')
    expect(ai.loadedRemaining).toBeNull()
    expect(ai.days).toBeNull()
    expect(ai.level).toBe('no_data')
  })

  it('a segment with leads but no campaign has no pace (no data), not a made-up countdown', () => {
    const [jw] = segmentRunway([{ segment: 'jeweler', ready: 120, unverified: 0 }], [])
    expect(jw.campaigns).toBe(0)
    expect(jw.level).toBe('no_data')
  })
})

describe('meta hints (placeholders only)', () => {
  it('reads an angle and a segment hint from a campaign name', () => {
    expect(angleHintFromName('TapDash Oct8 - Segment 1 Held Payouts')).toBe('Held Payouts')
    expect(angleHintFromName('Plain name')).toBeNull()
    expect(segmentHintFromName('TapDash Jewelry Retailers - Test 01')).toBe('jeweler')
    expect(segmentHintFromName('Other')).toBeNull()
  })
})

describe('database: pools and campaign meta', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('counts verified never-contacted leads per segment and leaves out touched, in-campaign and do-not-contact', async () => {
    const a = await addCompany(db, { name: 'Ready Jeweler' })
    await addContact(db, a, 'owner@ready.com', 'valid')
    const b = await addCompany(db, { name: 'Unverified Jeweler' })
    await addContact(db, b, 'x@unv.com', 'unverified')
    const c = await addCompany(db, { name: 'Touched Jeweler' })
    const cc = await addContact(db, c, 'y@touched.com', 'valid')
    await addTouch(db, { companyId: c, contactId: cc, campaign: 'Seg 3', event: 'email_sent', at: '2026-10-07T12:00:00Z' })
    const d = await addCompany(db, { name: 'In campaign', stage: 'in_campaign' })
    await addContact(db, d, 'z@inc.com', 'valid')
    const e = await addCompany(db, { name: 'DNC' })
    const ec = await addContact(db, e, 'n@dnc.com', 'valid')
    await db.query('update lp.contacts set do_not_contact = true where id = $1', [ec])
    const f = await addCompany(db, { name: 'Agency', segment: 'ai_agency' })
    await addContact(db, f, 'a@agency.ai', 'valid')
    const g = await addCompany(db, { name: 'Invalid' })
    await addContact(db, g, 'bad@inv.com', 'invalid')

    const pools = await segmentPools(db)
    const byS = Object.fromEntries(pools.map((p) => [p.segment, p]))
    expect(byS.jeweler).toEqual({ segment: 'jeweler', ready: 1, unverified: 1 })
    expect(byS.ai_agency).toEqual({ segment: 'ai_agency', ready: 1, unverified: 0 })
  })

  it('saves and updates campaign segment + angle', async () => {
    await saveCampaignMeta(db, 'owner', { campaign_id: 'cmp-1', campaign_name: 'One', segment: 'jeweler', angle: ' Held payouts ' })
    await saveCampaignMeta(db, 'owner', { campaign_id: 'cmp-1', segment: 'bogus', angle: '' })
    const m = await listCampaignMeta(db)
    expect(m.get('cmp-1')).toMatchObject({ campaign_name: 'One', segment: null, angle: null })
    await saveCampaignMeta(db, 'owner', { campaign_id: 'cmp-1', segment: 'ai_agency', angle: 'Builders' })
    expect((await listCampaignMeta(db)).get('cmp-1')).toMatchObject({ segment: 'ai_agency', angle: 'Builders' })
  })
})
