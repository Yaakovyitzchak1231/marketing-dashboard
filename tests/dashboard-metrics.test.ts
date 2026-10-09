import { describe, it, expect } from 'vitest'
import {
  campaignStatus, accountStatusWord, combinedTracking, countsFromApi, dailySeries, interestFrom, num, openTrackingOff, ratesFrom,
  ratio, repliedLeadsFrom, stepStats, sumAccountDaily, sumCounts, zeroCounts, EMPTY_COUNTS,
} from '@/lib/dashboard/metrics'
import { addDays, chunkRange, dateInZone, daysBetweenInclusive, previousRange, rangeFor, resolveTimezone } from '@/lib/dashboard/dates'
import type { ApiCampaign, ApiDailyRow, ApiEmail, ApiLead, ApiStepRow } from '@/lib/instantly/types'
import { fixture, C1, C2, C3 } from './helpers/instantly-fake'

const OFF = { open: false, link: false }
const ON = { open: true, link: true }

describe('countsFromApi', () => {
  const ov = fixture<Record<string, number>>('overview_range')

  it('maps the documented fields (contacted = new leads, replied = unique human replies)', () => {
    const c = countsFromApi(ov, OFF)
    expect(c).toEqual({
      sent: 2618, contacted: 705, opened: null, clicked: null, replied: 10, autoReplies: 11,
      bounced: 6, unsubscribed: 0, positive: 2, meetingsBooked: 1, opportunityValue: 2000,
    })
  })

  it('does NOT subtract automatic replies (Instantly already excludes them from reply_count_unique)', () => {
    expect(countsFromApi({ reply_count_unique: 10, reply_count_automatic_unique: 11 }, OFF).replied).toBe(10)
  })

  it('opens/clicks are null when tracking is off or unknown, a real 0 when it is on', () => {
    expect(countsFromApi(ov, OFF).opened).toBeNull()
    expect(countsFromApi(ov, { open: null, link: null }).opened).toBeNull()
    expect(countsFromApi(ov, ON).opened).toBe(0)
    expect(countsFromApi(ov, ON).clicked).toBe(0)
  })

  it('missing fields stay null; a reported 0 stays 0', () => {
    const c = countsFromApi({ emails_sent_count: 0 }, ON)
    expect(c.sent).toBe(0)
    expect(c.contacted).toBeNull()
    expect(c.replied).toBeNull()
    expect(c.meetingsBooked).toBeNull() // per-campaign analytics have no meetings field
    expect(countsFromApi(null, ON)).toEqual(EMPTY_COUNTS)
  })
})

describe('ratesFrom', () => {
  it('computes every rate from raw counts', () => {
    const r = ratesFrom({ ...EMPTY_COUNTS, sent: 2618, contacted: 705, replied: 10, positive: 2, bounced: 6, unsubscribed: 1, opened: null, clicked: null })
    expect(r.replyRate).toBeCloseTo(10 / 705, 10)
    expect(r.positiveRate).toBeCloseTo(2 / 705, 10)
    expect(r.positiveShareOfReplies).toBeCloseTo(0.2, 10)
    expect(r.bounceRate).toBeCloseTo(6 / 2618, 10)
    expect(r.unsubscribeRate).toBeCloseTo(1 / 705, 10)
    expect(r.openRate).toBeNull()
    expect(r.clickRate).toBeNull()
  })

  it('null on a zero or null denominator — never 0, never Infinity', () => {
    const r = ratesFrom({ ...EMPTY_COUNTS, sent: 0, contacted: 0, replied: 0, bounced: 0, positive: 0 })
    expect(r.replyRate).toBeNull()
    expect(r.bounceRate).toBeNull()
    expect(r.positiveShareOfReplies).toBeNull()
    expect(ratesFrom(EMPTY_COUNTS).replyRate).toBeNull()
    expect(ratio(0, 5)).toBe(0)
  })

  it('a share of people above 100% is impossible, so it is null (short-range cohort mismatch)', () => {
    expect(ratesFrom({ ...EMPTY_COUNTS, contacted: 2, replied: 5 }).replyRate).toBeNull()
  })
})

describe('helpers', () => {
  it('num accepts finite numbers and numeric strings only', () => {
    expect(num(3)).toBe(3)
    expect(num('4')).toBe(4)
    expect(num('')).toBeNull()
    expect(num(null)).toBeNull()
    expect(num(NaN)).toBeNull()
    expect(num('abc')).toBeNull()
  })
  it('maps campaign and account status codes', () => {
    expect([0, 1, 2, 3, 4, -99, -1, -2, 7].map(campaignStatus)).toEqual(['draft', 'active', 'paused', 'completed', 'active', 'error', 'error', 'error', 'unknown'])
    expect(accountStatusWord(1)).toBe('active')
    expect(accountStatusWord(-2)).toBe('soft bounce error')
    expect(accountStatusWord(undefined)).toBe('unknown')
  })
  it('combinedTracking is true/false only when every campaign agrees', () => {
    expect(combinedTracking([true, true])).toBe(true)
    expect(combinedTracking([false, false])).toBe(false)
    expect(combinedTracking([true, false])).toBeNull()
    expect(combinedTracking([])).toBeNull()
  })
  it('openTrackingOff: off only when every campaign that reports it says off', () => {
    expect(openTrackingOff([false, false])).toBe(true)
    expect(openTrackingOff([false, null])).toBe(true) // unknown is ignored, not guessed
    expect(openTrackingOff([true, false])).toBe(false)
    expect(openTrackingOff([null, null])).toBe(false) // nothing reported: not "off"
    expect(openTrackingOff([])).toBe(false)
  })
  it('zeroCounts: measured zeros, tracking-gated fields null when off', () => {
    const z = zeroCounts(OFF)
    expect(z.sent).toBe(0)
    expect(z.opened).toBeNull()
    expect(zeroCounts(ON).opened).toBe(0)
  })
  it('sumCounts nulls a field if any input lacks it', () => {
    const s = sumCounts([{ ...EMPTY_COUNTS, sent: 1, replied: 2 }, { ...EMPTY_COUNTS, sent: 3, replied: null }])
    expect(s.sent).toBe(4)
    expect(s.replied).toBeNull()
  })
  it('maps interest status codes', () => {
    expect([0, 1, 2, 3, 4, -1, -2, -3, -4, null, 12345].map(interestFrom)).toEqual([
      'out_of_office', 'interested', 'meeting_booked', 'meeting_completed', 'won', 'not_interested', 'wrong_person', 'lost', 'no_show', 'unlabeled', 'unlabeled',
    ])
  })
})

describe('dailySeries', () => {
  const rows = fixture<ApiDailyRow[]>('daily_range')
  it('fills days the API omitted with 0 and keeps real per-day counts', () => {
    const d = dailySeries(rows, '2026-09-09', '2026-09-12', OFF)
    expect(d.map((p) => p.date)).toEqual(['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'])
    expect(d[0]).toEqual({ date: '2026-09-09', sent: 54, contacted: 54, replied: 1, positive: 0, bounced: null, opened: null })
    expect(d[1].contacted).toBe(0) // a follow-up-only day: sends but no new leads
    expect(d[2]).toEqual({ date: '2026-09-11', sent: 0, contacted: 0, replied: 0, positive: 0, bounced: null, opened: null })
  })
  it('everything null when the daily call failed', () => {
    const d = dailySeries(null, '2026-09-09', '2026-09-10', ON)
    expect(d.every((p) => p.sent === null && p.replied === null)).toBe(true)
  })
})

describe('stepStats', () => {
  const camps = fixture<{ items: ApiCampaign[] }>('campaigns_page1').items
  const c1 = camps.find((c) => c.id === C1)
  it('0-based step/variant strings become step 1.. and A/B, null rows dropped, subjects attached', () => {
    const s = stepStats(fixture<ApiStepRow[]>('steps_c1'), c1, false)
    expect(s.map((x) => `${x.step}${x.variant}`)).toEqual(['1A', '1B', '2A'])
    expect(s[0]).toEqual({ step: 1, variant: 'A', subject: 'rewards cards at {{companyName}}', sent: 808, opened: null, replied: 2, positive: 1, replyRate: 2 / 808 })
    expect(s[1].subject).toBe('who pays for card rewards?')
    expect(s[2].subject).toBe('Re: rewards')
  })
  it('subject null when the campaign is unknown', () => {
    expect(stepStats(fixture<ApiStepRow[]>('steps_c2'), undefined, null)[0].subject).toBeNull()
  })
})

describe('sumAccountDaily', () => {
  it('sums per inbox, case-insensitively', () => {
    const m = sumAccountDaily(fixture('account_daily'))
    expect(m.get('sam@sender-one.example')).toEqual({ sent: 50, bounced: 1, replied: 1 })
    expect(m.get('sam@sender-two.example')).toEqual({ sent: 25, bounced: 2, replied: 0 })
  })
})

describe('repliedLeadsFrom', () => {
  const threads = [...fixture<{ items: ApiEmail[] }>('threads_page1').items, ...fixture<{ items: ApiEmail[] }>('threads_page2').items]
  const leads = fixture<{ items: ApiLead[] }>('leads_by_email').items
  const names = new Map([[C1, 'Jewelers - Test 01'], [C2, 'Segment 3 Cashback'], [C3, 'Old Signups']])
  const base = { threads, leads, campaignNames: names, timeZone: 'America/New_York', now: new Date('2026-10-09T18:00:00Z') }

  it('only leads Instantly recorded a reply for, newest first, awaiting = they wrote last', () => {
    const r = repliedLeadsFrom({ ...base, start: '2026-09-09', end: '2026-10-08' })
    expect(r.map((x) => x.email)).toEqual(['ann@shop-a.example', 'bob@shop-b.example'])
    expect(r[0]).toEqual({
      email: 'ann@shop-a.example', name: 'Ann Able', company: 'Shop A', campaignId: C1, campaignName: 'Jewelers - Test 01',
      interest: 'interested', lastReplyAt: '2026-10-07T17:23:30.000Z',
      lastReplySnippet: 'Sounds interesting, can you call me Thursday?', awaitingOurReply: true, daysWaiting: 2,
    })
    // Bob's thread ends with our email -> not awaiting, no snippet of ours shown as theirs.
    expect(r[1].awaitingOurReply).toBe(false)
    expect(r[1].lastReplySnippet).toBeNull()
    expect(r[1].daysWaiting).toBeNull()
    expect(r[1].interest).toBe('unlabeled')
  })
  it('all-time includes older replies; limit applies', () => {
    const r = repliedLeadsFrom({ ...base, start: null, end: '2026-10-08' })
    expect(r.map((x) => x.email)).toEqual(['ann@shop-a.example', 'bob@shop-b.example', 'old@shop-d.example'])
    expect(r[2].company).toBeNull()
    expect(repliedLeadsFrom({ ...base, start: null, end: '2026-10-08', limit: 1 })).toHaveLength(1)
  })
  it('the range is judged in the dashboard timezone', () => {
    // 2026-10-07T17:23Z is Oct 7 in New York; a range ending Oct 6 excludes it.
    expect(repliedLeadsFrom({ ...base, start: '2026-10-07', end: '2026-10-07' }).map((x) => x.email)).toEqual(['ann@shop-a.example'])
    expect(repliedLeadsFrom({ ...base, start: '2026-09-01', end: '2026-10-06' }).map((x) => x.email)).toEqual(['bob@shop-b.example'])
  })
})

describe('date ranges', () => {
  it('last N calendar days in the dashboard timezone, today included', () => {
    const r = rangeFor('7d', new Date('2026-10-08T16:00:00Z'), 'America/New_York')
    expect(r).toEqual({ key: '7d', start: '2026-10-02', end: '2026-10-08', timezone: 'America/New_York' })
    expect(daysBetweenInclusive(r.start!, r.end)).toBe(7)
  })
  it('midnight edge: 03:30Z on Oct 8 is still Oct 7 in New York', () => {
    const now = new Date('2026-10-08T03:30:00Z')
    expect(dateInZone(now, 'America/New_York')).toBe('2026-10-07')
    expect(dateInZone(now, 'UTC')).toBe('2026-10-08')
    expect(rangeFor('30d', now, 'America/New_York')).toMatchObject({ start: '2026-09-08', end: '2026-10-07' })
    expect(rangeFor('30d', now, 'UTC')).toMatchObject({ start: '2026-09-09', end: '2026-10-08' })
  })
  it('previous period is the same length immediately before', () => {
    const r = rangeFor('30d', new Date('2026-10-08T16:00:00Z'), 'America/New_York')
    expect(previousRange(r)).toEqual({ key: '30d', start: '2026-08-10', end: '2026-09-08', timezone: 'America/New_York' })
    const w = rangeFor('7d', new Date('2026-03-10T12:00:00Z'), 'America/New_York') // spans the DST change
    expect(previousRange(w)).toMatchObject({ start: '2026-02-25', end: '2026-03-03' })
  })
  it('all-time has no start and no previous period', () => {
    const r = rangeFor('all', new Date('2026-10-08T16:00:00Z'), 'America/New_York')
    expect(r.start).toBeNull()
    expect(previousRange(r)).toBeNull()
  })
  it('chunks long ranges into <=31-day windows with no gaps', () => {
    const w = chunkRange('2026-07-11', '2026-10-08', 31)
    expect(w).toEqual([
      { start: '2026-07-11', end: '2026-08-10' },
      { start: '2026-08-11', end: '2026-09-10' },
      { start: '2026-09-11', end: '2026-10-08' },
    ])
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('a bad DASHBOARD_TZ falls back to New York', () => {
    expect(resolveTimezone('Not/AZone')).toBe('America/New_York')
    expect(resolveTimezone(undefined)).toBe('America/New_York')
    expect(resolveTimezone('Europe/London')).toBe('Europe/London')
  })
})
