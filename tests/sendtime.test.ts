import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import {
  computeCampaignWindow,
  computeSendWindow,
  getCampaignSendWindow,
  getSendWindow,
  isWindowExpired,
  leadKey,
  parseLeadKey,
  pickWindow,
  recomputeSendWindow,
  recomputeSendWindows,
  DEFAULT_TIMEZONE,
  MIN_SAMPLE,
  SendTimeError,
  WINDOW_MAX_AGE_DAYS,
  type SendWindow,
} from '@/lib/sendtime/analyze'
import { isValidTimezone, resolveTimezone } from '@/lib/sendtime/tz'
import { optimalSendAt, resolveSendTime } from '@/lib/sendtime/schedule'
import { runOp } from '@/lib/ops/dispatch'
import { nextRun } from '@/lib/jobs/cron'
import { pollOnce } from '../runner/lib.mjs'
import * as opsCallHandler from '../runner/handlers/ops_call.mjs'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// The shared box is slow; PGlite boots a full Postgres per test.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })

const MON_11AM_EDT = new Date('2026-10-12T15:00:00Z') // Monday, 11:00 AM EDT
const NOW = MON_11AM_EDT

function win(over: Partial<SendWindow> = {}): SendWindow {
  return {
    lead_key: 'company:1',
    best_hour: 10,
    best_dow: null,
    timezone: 'America/New_York',
    timezone_source: 'default',
    basis: 'own',
    sample_size: 20,
    last_engagement: new Date(NOW.getTime() - 86400000),
    updated_at: new Date(),
    ...over,
  }
}

/** Hour of day (0-23) of an instant in a timezone. */
function localHour(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).formatToParts(d)
  return Number(parts.find((p) => p.type === 'hour')!.value)
}

describe('pickWindow (pure bucketing)', () => {
  it('picks the hour with the most engagement, replies weighing more than clicks', () => {
    const w = pickWindow([
      { h: 9, dow: 1, n: 5, w: 10 }, // five clicks
      { h: 15, dow: 2, n: 4, w: 12 }, // four replies
    ])
    expect(w?.best_hour).toBe(15)
    expect(w?.sample_size).toBe(9)
  })

  it('returns null below the minimum sample (8)', () => {
    expect(MIN_SAMPLE).toBe(8)
    expect(pickWindow([{ h: 10, dow: 1, n: MIN_SAMPLE - 1 }])).toBeNull()
    expect(pickWindow([{ h: 10, dow: 1, n: MIN_SAMPLE }])).not.toBeNull()
  })

  it('smooths neighbouring hours: a lead active at 10 and 11 peaks between them, ties toward mid-business-day', () => {
    const w = pickWindow([
      { h: 10, dow: 1, n: 4 },
      { h: 11, dow: 1, n: 4 },
    ])
    expect(w?.best_hour).toBe(11) // 10 and 11 smooth equal; 11 is closer to 13:00
  })

  it('smooths circularly across midnight', () => {
    const w = pickWindow([
      { h: 23, dow: 1, n: 4 },
      { h: 0, dow: 2, n: 4 },
    ])
    // 23 and 0 hear each other across midnight, so both smooth to 12; 23 is nearer 13:00.
    expect(w?.best_hour).toBe(23)
  })

  it('thin, scattered evidence does not resolve to midnight: ties go toward the middle of business hours', () => {
    const scattered = [6, 8, 10, 12, 14, 16, 18, 20].map((h) => ({ h, dow: 2, n: 1 }))
    const w = pickWindow(scattered)
    expect(w?.best_hour).toBe(13)
    expect(w?.best_hour).not.toBe(0)
  })

  it('an isolated peak beats its smoothed neighbours', () => {
    expect(pickWindow([{ h: 10, dow: 3, n: 9 }])?.best_hour).toBe(10)
  })

  it('sets best_dow only when one weekday clearly wins', () => {
    const concentrated = pickWindow([
      { h: 10, dow: 2, n: 12 },
      { h: 10, dow: 3, n: 1 },
      { h: 10, dow: 4, n: 1 },
    ])
    expect(concentrated?.best_dow).toBe(2)
    const flat = pickWindow([1, 2, 3, 4, 5].map((dow) => ({ h: 10, dow, n: 2 })))
    expect(flat?.best_dow).toBeNull()
  })

  it('never picks a weekend day for best_dow, even when the weekend dominates', () => {
    const saturday = pickWindow([
      { h: 10, dow: 6, n: 12 },
      { h: 10, dow: 2, n: 1 },
    ])
    expect(saturday?.best_dow).toBeNull()
    const sunday = pickWindow([{ h: 10, dow: 0, n: 20 }])
    expect(sunday?.best_dow).toBeNull()
    // Weekend engagement still informs the hour.
    expect(sunday?.best_hour).toBe(10)
    const weekdayWins = pickWindow([
      { h: 10, dow: 6, n: 3 },
      { h: 10, dow: 4, n: 10 },
    ])
    expect(weekdayWins?.best_dow).toBe(4)
  })
})

describe('lead keys (one helper, main convention)', () => {
  it('prefers the contact when present and round-trips through parseLeadKey', () => {
    expect(leadKey(7, 9)).toBe('contact:9')
    expect(leadKey(7, null)).toBe('company:7')
    expect(parseLeadKey('contact:9')).toEqual({ kind: 'contact', id: 9 })
    expect(parseLeadKey('company:7')).toEqual({ kind: 'company', id: 7 })
  })
  it('rejects empty input and anything that is not company:<id> / contact:<id>', () => {
    expect(() => leadKey(null, null)).toThrow(SendTimeError)
    for (const bad of ['7:9', 'company:0', 'contact:abc', 'company:', 'lead:3', 'company:3:4']) {
      expect(() => parseLeadKey(bad), bad).toThrow(SendTimeError)
    }
  })
})

describe('timezone validation', () => {
  it('accepts real IANA names and rejects everything else', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    for (const bad of ['', 'Not/AZone', 'EST5EDT; drop table', '+05:00', 'America/New York', null, undefined, 42]) {
      expect(isValidTimezone(bad), String(bad)).toBe(false)
    }
  })
  it('labels the fallback as the default, and a real zone as lead-specific', () => {
    expect(resolveTimezone('America/Chicago')).toEqual({ timezone: 'America/Chicago', timezone_source: 'lead' })
    expect(resolveTimezone('nonsense')).toEqual({ timezone: DEFAULT_TIMEZONE, timezone_source: 'default' })
    expect(resolveTimezone(undefined)).toEqual({ timezone: DEFAULT_TIMEZONE, timezone_source: 'default' })
  })
})

describe('optimalSendAt (pure date math)', () => {
  it('moves a past-today window to tomorrow at best_hour', () => {
    // 11:00 AM EDT is past the 10 AM window: next is Tue 10:00 AM EDT = 14:00 UTC
    expect(optimalSendAt(win(), MON_11AM_EDT).toISOString()).toBe('2026-10-13T14:00:00.000Z')
  })
  it('keeps today when the window is still ahead', () => {
    expect(optimalSendAt(win(), new Date('2026-10-12T13:00:00Z')).toISOString()).toBe('2026-10-12T14:00:00.000Z') // 9:00 AM EDT
  })
  it('prefers the best day of week when it is within the 48h cap', () => {
    // best_dow = 3 (Wednesday); Monday 11 AM -> Wednesday 10 AM EDT (47h)
    expect(optimalSendAt(win({ best_dow: 3 }), MON_11AM_EDT).toISOString()).toBe('2026-10-14T14:00:00.000Z')
  })
  it('never returns a time in the past', () => {
    expect(optimalSendAt(win({ best_hour: 23 }), MON_11AM_EDT).getTime()).toBeGreaterThanOrEqual(MON_11AM_EDT.getTime())
  })
  it('clamps a 3am best hour into business hours (8am local)', () => {
    // Monday 11 AM EDT, best_hour 3 -> clamped to 8 AM; 8 AM already passed, so Tue 8 AM EDT = 12:00 UTC
    expect(optimalSendAt(win({ best_hour: 3 }), MON_11AM_EDT).toISOString()).toBe('2026-10-13T12:00:00.000Z')
  })
  it('clamps a late-night best hour to 6pm local', () => {
    expect(optimalSendAt(win({ best_hour: 23 }), MON_11AM_EDT).toISOString()).toBe('2026-10-12T22:00:00.000Z')
  })

  it('G2: when the weekday shift exceeds 48h it falls back to the clamped best-hour time, not the raw due time', () => {
    // best_dow = Friday; Monday 11 AM is ~4 days from Friday 10 AM, over the cap.
    const out = optimalSendAt(win({ best_dow: 5 }), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-13T14:00:00.000Z') // Tue 10:00 EDT: the best-hour candidate
    expect(out.getTime() - MON_11AM_EDT.getTime()).toBeLessThanOrEqual(24 * 3600000)
  })
  it('G2: a step due at 03:00 local with a far best_dow goes out inside business hours, never at 3am', () => {
    const due = new Date('2026-10-12T07:00:00Z') // Monday 03:00 EDT
    const out = optimalSendAt(win({ best_hour: 3, best_dow: 5 }), due)
    expect(out.getTime()).not.toBe(due.getTime())
    expect(localHour(out, 'America/New_York')).toBe(8)
    expect(out.toISOString()).toBe('2026-10-12T12:00:00.000Z')
  })
  it('ignores a weekend best_dow (legacy or hand-edited row) instead of shifting onto the weekend', () => {
    const out = optimalSendAt(win({ best_dow: 0 }), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-13T14:00:00.000Z')
  })

  it('O7: an invalid timezone never throws; the due time comes back', () => {
    for (const timezone of ['Not/AZone', '', "x'; drop table lp.companies; --", '+05:00']) {
      expect(() => optimalSendAt(win({ timezone }), MON_11AM_EDT), timezone).not.toThrow()
      expect(optimalSendAt(win({ timezone }), MON_11AM_EDT).getTime()).toBe(MON_11AM_EDT.getTime())
    }
  })
  it('does not throw on a non-finite hour or an invalid due date', () => {
    expect(optimalSendAt(win({ best_hour: Number.NaN }), MON_11AM_EDT).getTime()).toBe(MON_11AM_EDT.getTime())
    const bad = new Date('nope')
    expect(() => optimalSendAt(win(), bad)).not.toThrow()
  })

  describe('O12: DST', () => {
    const NY = 'America/New_York'
    it('a step due at 02:00 local on US spring-forward day resolves to a real instant inside allowed hours', () => {
      // 2026-03-08: clocks jump 02:00 EST -> 03:00 EDT. 02:00 does not exist; the instants
      // around it are 06:59:59Z (01:59:59 EST) and 07:00:00Z (03:00:00 EDT).
      for (const iso of ['2026-03-08T06:00:00Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z']) {
        const due = new Date(iso)
        const out = optimalSendAt(win({ best_hour: 2 }), due)
        expect(Number.isNaN(out.getTime()), iso).toBe(false)
        expect(out.getTime(), iso).toBeGreaterThanOrEqual(due.getTime())
        const h = localHour(out, NY)
        expect(h, iso).toBeGreaterThanOrEqual(8)
        expect(h, iso).toBeLessThanOrEqual(18)
        // 08:00 EDT that morning = 12:00Z (offset is -4 after the jump, not -5)
        expect(out.toISOString(), iso).toBe('2026-03-08T12:00:00.000Z')
      }
    })
    it('a window shifted across the spring-forward boundary uses the new offset', () => {
      // Saturday 3pm EST -> Sunday 10:00 EDT (14:00Z), not 15:00Z
      const out = optimalSendAt(win({ best_hour: 10 }), new Date('2026-03-07T20:00:00Z'))
      expect(out.toISOString()).toBe('2026-03-08T14:00:00.000Z')
      expect(localHour(out, NY)).toBe(10)
    })
    it('fall-back day: 8:00 local is 8:00 EST (13:00Z)', () => {
      const out = optimalSendAt(win({ best_hour: 8 }), new Date('2026-11-01T05:30:00Z')) // 01:30 EDT
      expect(out.toISOString()).toBe('2026-11-01T13:00:00.000Z')
      expect(localHour(out, NY)).toBe(8)
    })
    it('works in a southern-hemisphere zone too', () => {
      const out = optimalSendAt(win({ timezone: 'Australia/Sydney', best_hour: 9 }), new Date('2026-10-03T10:00:00Z'))
      expect(localHour(out, 'Australia/Sydney')).toBe(9)
      expect(out.getTime()).toBeGreaterThan(new Date('2026-10-03T10:00:00Z').getTime())
    })
  })
})

describe('send windows (db)', () => {
  let db: TestDb
  let companyId: number
  let contactId: number

  beforeEach(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Sendtime Co' })
    contactId = await addContact(db, companyId, 's@sendtime.test')
  })
  afterEach(async () => {
    await db.close()
  })

  /** An engagement event `daysAgo` before NOW at hh:mm UTC. */
  async function engage(
    daysAgo: number,
    opts: { type?: string; at?: string; contact?: number | null; company?: number | null; props?: Record<string, unknown>; campaign?: number | null } = {},
  ) {
    const at = opts.at ?? '14:05'
    const day = new Date(NOW.getTime() - daysAgo * 86400000).toISOString().slice(0, 10)
    await db.query(
      `insert into lp.lead_events (type, company_id, contact_id, campaign_id, occurred_at, source, props)
       values ($1, $2, $3, $4, $5::timestamptz, 'test', $6::jsonb)`,
      [
        opts.type ?? 'email_link_clicked',
        opts.company === undefined ? companyId : opts.company,
        opts.contact === undefined ? contactId : opts.contact,
        opts.campaign ?? null,
        `${day}T${at}:00Z`,
        JSON.stringify(opts.props ?? {}),
      ],
    )
  }
  /** n click events for a lead, one per day, at 14:05Z (10:05 EDT). */
  async function clicks(n: number, o: Parameters<typeof engage>[1] = {}) {
    for (let d = 1; d <= n; d++) await engage(d, o)
  }

  async function newCampaign(name = 'C') {
    const r = await db.query<{ id: number }>('insert into lp.campaigns (name) values ($1) returning id', [name])
    return Number(r.rows[0].id)
  }

  describe('learning', () => {
    it('learns the best hour from replies and clicks, ignoring opens and low-trust events', async () => {
      await clicks(6) // 10:05 EDT
      await engage(7, { type: 'reply_received', at: '14:30' })
      await engage(8, { type: 'reply_received', at: '14:45' })
      // Opens at 3am UTC, many: excluded entirely (O6).
      for (let d = 1; d <= 12; d++) await engage(d, { type: 'email_opened', at: '03:05' })
      // A low-trust click at 20:00Z (scanner): excluded.
      for (let d = 1; d <= 5; d++) await engage(d, { at: '20:00', props: { low_trust: true } })
      const key = leadKey(companyId, contactId)
      const computed = await computeSendWindow(db, key, { now: NOW })
      expect(computed).toMatchObject({ best_hour: 10, sample_size: 8, timezone: DEFAULT_TIMEZONE, timezone_source: 'default', basis: 'own' })
      const stored = await recomputeSendWindow(db, key, { now: NOW })
      expect(stored).toMatchObject({ lead_key: key, best_hour: 10, timezone_source: 'default' })
      expect(await getSendWindow(db, key)).toMatchObject({ best_hour: 10, sample_size: 8 })
    })

    it('opens alone never produce a window', async () => {
      for (let d = 1; d <= 20; d++) await engage(d, { type: 'email_opened' })
      expect(await computeSendWindow(db, leadKey(companyId, contactId), { now: NOW })).toBeNull()
    })

    it('buckets by occurred_at (when the person engaged), not when the event was recorded', async () => {
      // Ingested a day late (recorded_at far from occurred_at): must not matter.
      await db.query(
        `insert into lp.lead_events (type, company_id, contact_id, occurred_at, recorded_at, source)
         select 'email_link_clicked', $1, $2, $3::timestamptz - (g || ' days')::interval, $3::timestamptz + interval '20 hours', 'test'
         from generate_series(1, 8) g`,
        [companyId, contactId, '2026-10-11T14:05:00Z'],
      )
      expect((await computeSendWindow(db, leadKey(companyId, contactId), { now: NOW }))?.best_hour).toBe(10)
    })

    it('leaves the row alone when there is not enough evidence', async () => {
      await engage(1)
      const key = leadKey(companyId, contactId)
      expect(await recomputeSendWindow(db, key, { now: NOW })).toBeNull()
      expect(await getSendWindow(db, key)).toBeNull()
    })

    it('O7: an invalid timezone does not error in SQL; it falls back to the default and says so', async () => {
      await clicks(8)
      const key = leadKey(companyId, contactId)
      const bad = await computeSendWindow(db, key, { now: NOW, timezone: "Not/AZone'; drop table lp.companies;--" })
      expect(bad).toMatchObject({ timezone: DEFAULT_TIMEZONE, timezone_source: 'default', best_hour: 10 })
      const chicago = await computeSendWindow(db, key, { now: NOW, timezone: 'America/Chicago' })
      expect(chicago).toMatchObject({ timezone: 'America/Chicago', timezone_source: 'lead', best_hour: 9 }) // 14:05Z = 09:05 CDT
      expect((await db.query('select count(*)::int n from lp.companies')).rows[0]).toMatchObject({ n: 1 })
    })

    it('O7: a stored lead timezone is kept, a stored garbage one is replaced by the labelled default', async () => {
      await clicks(8)
      const key = leadKey(companyId, contactId)
      await recomputeSendWindow(db, key, { now: NOW, timezone: 'America/Los_Angeles' })
      expect(await computeSendWindow(db, key, { now: NOW })).toMatchObject({ timezone: 'America/Los_Angeles', timezone_source: 'lead' })
      await db.query(`update lp.lead_send_windows set timezone = 'garbage' where lead_key = $1`, [key])
      expect(await computeSendWindow(db, key, { now: NOW })).toMatchObject({ timezone: DEFAULT_TIMEZONE, timezone_source: 'default' })
    })

    it('O9: a contact with too little of its own evidence falls back to its company events', async () => {
      await clicks(3) // the contact's own: below MIN_SAMPLE
      // company-level events (no contact), 10:05 EDT
      for (let d = 4; d <= 9; d++) await engage(d, { contact: null })
      const key = leadKey(companyId, contactId)
      const w = await computeSendWindow(db, key, { now: NOW })
      expect(w).toMatchObject({ basis: 'company', best_hour: 10, sample_size: 9 })
      const stored = await recomputeSendWindow(db, key, { now: NOW })
      expect(stored?.basis).toBe('company')
    })

    it('O9: a contact with enough of its own evidence uses only its own', async () => {
      await clicks(8)
      for (let d = 9; d <= 20; d++) await engage(d, { contact: null, at: '19:05' }) // company noise at 15:05 EDT
      const w = await computeSendWindow(db, leadKey(companyId, contactId), { now: NOW })
      expect(w).toMatchObject({ basis: 'own', best_hour: 10, sample_size: 8 })
    })

    it('O9: a contact with no company events and too little of its own still has no window', async () => {
      await clicks(3)
      expect(await computeSendWindow(db, leadKey(companyId, contactId), { now: NOW })).toBeNull()
    })

    it('O10: evidence older than the age limit is ignored', async () => {
      for (let d = 0; d < 8; d++) await engage(WINDOW_MAX_AGE_DAYS + 5 + d)
      expect(await computeSendWindow(db, leadKey(companyId, contactId), { now: NOW })).toBeNull()
    })
  })

  describe('expiry (O10)', () => {
    it('isWindowExpired: older than 180 days is expired', () => {
      const day = 86400000
      expect(isWindowExpired({ last_engagement: new Date(NOW.getTime() - 179 * day) }, NOW)).toBe(false)
      expect(isWindowExpired({ last_engagement: new Date(NOW.getTime() - 181 * day) }, NOW)).toBe(true)
    })

    it('resolveSendTime treats an expired window as absent and passes the due time through', async () => {
      const key = leadKey(companyId, contactId)
      const insert = (days: number) =>
        db.query(
          `insert into lp.lead_send_windows (lead_key, best_hour, best_dow, timezone, timezone_source, sample_size, last_engagement, basis)
           values ($1, 10, null, 'America/New_York', 'default', 12, $2::timestamptz, 'own')
           on conflict (lead_key) do update set last_engagement = excluded.last_engagement`,
          [key, new Date(NOW.getTime() - days * 86400000).toISOString()],
        )
      await insert(200)
      const stale = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT, { now: NOW })
      expect(stale).toMatchObject({ shifted: false, window: null, source: null })
      expect(stale.send_at).toEqual(MON_11AM_EDT)
      await insert(10)
      const fresh = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT, { now: NOW })
      expect(fresh).toMatchObject({ shifted: true, source: 'lead' })
      expect(fresh.send_at.toISOString()).toBe('2026-10-13T14:00:00.000Z')
    })

    it('the sendtime_window op relearns an expired window instead of serving it', async () => {
      const key = leadKey(companyId, contactId)
      await db.query(
        `insert into lp.lead_send_windows (lead_key, best_hour, timezone, sample_size, last_engagement)
         values ($1, 3, 'America/New_York', 9, now() - interval '400 days')`,
        [key],
      )
      // No fresh evidence: nothing usable.
      const none = (await runOp(db, 'system', 'sendtime_window', { contact_id: contactId })) as { window: unknown }
      expect(none.window).toBeNull()
    })
  })

  describe('resolveSendTime', () => {
    it('shifts into the window, or passes through without one', async () => {
      await clicks(8)
      const key = leadKey(companyId, contactId)
      await recomputeSendWindow(db, key, { now: NOW })
      const shifted = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT, { now: NOW })
      expect(shifted).toMatchObject({ shifted: true, source: 'lead' })
      expect(shifted.send_at.toISOString()).toBe('2026-10-13T14:00:00.000Z')

      const company2 = await addCompany(db, { name: 'No History Co' })
      const passthrough = await resolveSendTime(db, company2, null, MON_11AM_EDT, { now: NOW })
      expect(passthrough).toMatchObject({ shifted: false, window: null, source: null })
      expect(passthrough.send_at).toEqual(MON_11AM_EDT)
    })

    it('computeIfMissing learns the window on demand', async () => {
      await clicks(8)
      const r = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT, { now: NOW, computeIfMissing: true })
      expect(r).toMatchObject({ shifted: true, source: 'lead' })
    })

    it('does not throw when the stored timezone is garbage; the due time comes back', async () => {
      const key = leadKey(companyId, contactId)
      await db.query(
        `insert into lp.lead_send_windows (lead_key, best_hour, timezone, sample_size, last_engagement) values ($1, 10, 'Not/AZone', 9, $2)`,
        [key, new Date(NOW.getTime() - 86400000).toISOString()],
      )
      const r = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT, { now: NOW })
      expect(r.send_at).toEqual(MON_11AM_EDT)
      expect(r.shifted).toBe(false)
    })
  })

  describe('campaign fallback (O8)', () => {
    it('aggregates the campaign leads’ engagement and is used for a lead with no window', async () => {
      const campaign = await newCampaign()
      // Three leads, each too thin alone (3 clicks), together 9 >= MIN_SAMPLE.
      const members: number[] = []
      for (let i = 0; i < 3; i++) {
        const c = await addCompany(db, { name: `Member ${i}` })
        members.push(c)
        await db.query('insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)', [campaign, c])
        await clicks(3, { company: c, contact: null })
      }
      expect(await computeSendWindow(db, `company:${members[0]}`, { now: NOW })).toBeNull()
      const camp = await computeCampaignWindow(db, campaign, { now: NOW })
      expect(camp).toMatchObject({ best_hour: 10, sample_size: 9, timezone: DEFAULT_TIMEZONE, timezone_source: 'default' })

      // A lead in the campaign with no evidence of its own gets the campaign window.
      const newcomer = await addCompany(db, { name: 'Newcomer' })
      await db.query('insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)', [campaign, newcomer])
      const r = await resolveSendTime(db, newcomer, null, MON_11AM_EDT, { now: NOW, campaignId: campaign, computeIfMissing: true })
      expect(r).toMatchObject({ shifted: true, source: 'campaign' })
      expect(r.send_at.toISOString()).toBe('2026-10-13T14:00:00.000Z')
      expect(await getCampaignSendWindow(db, campaign)).toMatchObject({ best_hour: 10 })
    })

    it('a lead’s own window wins over the campaign’s', async () => {
      const campaign = await newCampaign()
      await db.query('insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)', [campaign, companyId])
      await clicks(8, { at: '19:05' }) // 15:05 EDT, own
      await recomputeSendWindow(db, leadKey(companyId, contactId), { now: NOW })
      await db.query(
        `insert into lp.campaign_send_windows (campaign_id, best_hour, timezone, sample_size, last_engagement) values ($1, 9, 'America/New_York', 20, $2)`,
        [campaign, new Date(NOW.getTime() - 86400000).toISOString()],
      )
      const r = await resolveSendTime(db, companyId, contactId, new Date('2026-10-12T13:00:00Z'), { now: NOW, campaignId: campaign })
      expect(r.source).toBe('lead')
      expect(localHour(r.send_at, 'America/New_York')).toBe(15)
    })

    it('an expired campaign window is ignored', async () => {
      const campaign = await newCampaign()
      await db.query(
        `insert into lp.campaign_send_windows (campaign_id, best_hour, timezone, sample_size, last_engagement) values ($1, 9, 'America/New_York', 20, $2)`,
        [campaign, new Date(NOW.getTime() - 300 * 86400000).toISOString()],
      )
      const r = await resolveSendTime(db, companyId, null, MON_11AM_EDT, { now: NOW, campaignId: campaign })
      expect(r).toMatchObject({ shifted: false, source: null })
    })

    it('thin campaign evidence yields no campaign window', async () => {
      const campaign = await newCampaign()
      await db.query('insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)', [campaign, companyId])
      await clicks(2)
      expect(await computeCampaignWindow(db, campaign, { now: NOW })).toBeNull()
    })
  })

  describe('recomputeSendWindows (batch)', () => {
    /** n companies, each with 8 identical-timestamp clicks: every lead ties on last_engagement. */
    async function tiedLeads(n: number): Promise<number[]> {
      const ids: number[] = []
      for (let i = 0; i < n; i++) ids.push(await addCompany(db, { name: `Bulk ${i}` }))
      await db.query(
        `insert into lp.lead_events (type, company_id, occurred_at, source)
         select 'email_link_clicked', c.id, $1::timestamptz - (g || ' days')::interval, 'test'
         from lp.companies c cross join generate_series(1, 8) g
         where c.name like 'Bulk %'`,
        ['2026-10-10T14:05:00Z'],
      )
      return ids
    }
    const storedCount = async () => Number((await db.query('select count(*)::int n from lp.lead_send_windows')).rows[0].n)

    it('G1: the report matches what was stored (insufficient evidence is skipped, never counted as recomputed)', async () => {
      await clicks(8) // enough
      const thin = await addCompany(db, { name: 'Thin Co' })
      await engage(1, { company: thin, contact: null }) // 1 event
      await engage(2, { company: thin, contact: null })
      const r = await recomputeSendWindows(db, { now: NOW })
      expect(r).toMatchObject({ recomputed: 1, skipped: 1 })
      expect(await storedCount()).toBe(1)
    })

    it('G1: a lead whose evidence dropped below MIN_SAMPLE is skipped and its stored row is untouched', async () => {
      const key = leadKey(companyId, contactId)
      await db.query(
        `insert into lp.lead_send_windows (lead_key, best_hour, timezone, sample_size, last_engagement, updated_at)
         values ($1, 7, 'America/New_York', 30, $2, '2026-09-01T00:00:00Z')`,
        [key, new Date(NOW.getTime() - 30 * 86400000).toISOString()],
      )
      await clicks(3) // below MIN_SAMPLE now
      const r = await recomputeSendWindows(db, { now: NOW })
      expect(r).toMatchObject({ recomputed: 0, skipped: 1 })
      const after = await getSendWindow(db, key)
      expect(after).toMatchObject({ best_hour: 7, sample_size: 30 })
      expect(after?.updated_at.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    })

    it('G3: limit below the page size is honoured exactly', async () => {
      await tiedLeads(60)
      const r = await recomputeSendWindows(db, { limit: 50, now: NOW })
      expect(r.recomputed + r.skipped).toBe(50)
      expect(r.recomputed).toBe(50)
      expect(await storedCount()).toBe(50)
    })

    it('G3: paging over ties neither skips nor repeats leads (keyset on last_engagement, lead_key)', async () => {
      await tiedLeads(23)
      const r = await recomputeSendWindows(db, { limit: 23, pageSize: 5, now: NOW })
      expect(r).toMatchObject({ recomputed: 23, skipped: 0 })
      expect(await storedCount()).toBe(23)
      // Every lead got exactly one window.
      const distinct = Number((await db.query('select count(distinct lead_key)::int n from lp.lead_send_windows')).rows[0].n)
      expect(distinct).toBe(23)
    })

    it('G3: a limit that is not a multiple of the page size stops exactly at the limit', async () => {
      await tiedLeads(12)
      const r = await recomputeSendWindows(db, { limit: 7, pageSize: 5, now: NOW })
      expect(r.recomputed).toBe(7)
      expect(await storedCount()).toBe(7)
    })

    it('G3: most-recently-engaged leads come first, and a later run with a bigger limit covers the rest', async () => {
      const ids = await tiedLeads(4)
      // Make company #3 the freshest.
      await engage(1, { company: ids[3], contact: null }) // a click on Oct 11, newer than every Oct 10 event
      await recomputeSendWindows(db, { limit: 1, now: NOW })
      expect((await db.query<{ lead_key: string }>('select lead_key from lp.lead_send_windows')).rows.map((x) => x.lead_key)).toEqual([`company:${ids[3]}`])
      const all = await recomputeSendWindows(db, { limit: 10, now: NOW })
      expect(all.recomputed).toBe(4)
    })

    it('O3: contact-only leads (events with no company) are relearned', async () => {
      const orphanContact = await addContact(db, companyId, 'orphan@sendtime.test')
      for (let d = 1; d <= 8; d++) await engage(d, { company: null, contact: orphanContact })
      const r = await recomputeSendWindows(db, { now: NOW })
      expect(r.recomputed).toBe(1)
      expect(await getSendWindow(db, `contact:${orphanContact}`)).toMatchObject({ best_hour: 10, sample_size: 8 })
    })

    it('O3: campaign scoping includes contact-only leads pinned in campaign_leads, and events tagged with the campaign', async () => {
      const campaign = await newCampaign()
      const pinned = await addContact(db, companyId, 'pinned@sendtime.test')
      await db.query('insert into lp.campaign_leads (campaign_id, company_id, contact_id) values ($1, $2, $3)', [campaign, companyId, pinned])
      for (let d = 1; d <= 8; d++) await engage(d, { company: null, contact: pinned })
      const tagged = await addContact(db, companyId, 'tagged@sendtime.test')
      for (let d = 1; d <= 8; d++) await engage(d, { company: null, contact: tagged, campaign })
      const outsider = await addCompany(db, { name: 'Outsider' })
      for (let d = 1; d <= 8; d++) await engage(d, { company: outsider, contact: null })
      const r = await recomputeSendWindows(db, { campaign_id: campaign, now: NOW })
      expect(r.recomputed).toBe(2)
      const keys = (await db.query<{ lead_key: string }>('select lead_key from lp.lead_send_windows order by lead_key')).rows.map((x) => x.lead_key)
      expect(keys).toEqual([`contact:${pinned}`, `contact:${tagged}`].sort())
    })

    it('ignores opens and old events when discovering leads', async () => {
      for (let d = 1; d <= 20; d++) await engage(d, { type: 'email_opened' })
      const stale = await addCompany(db, { name: 'Old Co' })
      for (let d = 0; d < 8; d++) await engage(120 + d, { company: stale, contact: null }) // outside the 90-day discovery window
      const r = await recomputeSendWindows(db, { now: NOW })
      expect(r).toMatchObject({ recomputed: 0, skipped: 0 })
    })

    it('also relearns the campaign windows and reports them', async () => {
      const campaign = await newCampaign()
      await db.query('insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)', [campaign, companyId])
      await clicks(8)
      const r = await recomputeSendWindows(db, { now: NOW })
      expect(r.campaigns_recomputed).toBe(1)
      expect(await getCampaignSendWindow(db, campaign)).toMatchObject({ best_hour: 10, sample_size: 8 })
    })
  })

  describe('the nightly job (O1)', () => {
    it('0063 seeds an enabled ops_call job for sendtime_recompute that runs nightly in UTC', async () => {
      const { rows } = await db.query<Record<string, unknown>>(`select * from lp.jobs where name = 'sendtime_recompute'`)
      expect(rows).toHaveLength(1)
      const job = rows[0]
      expect(job).toMatchObject({ kind: 'ops_call', timezone: 'UTC', enabled: true })
      expect(job.payload).toEqual({ op: 'sendtime_recompute', args: {} })
      expect(Number(job.timeout_s)).toBeGreaterThanOrEqual(300)
      // a nightly cron: once a day
      const a = nextRun(String(job.schedule_cron), new Date('2026-10-12T00:00:00Z'), 'UTC')
      const b = nextRun(String(job.schedule_cron), a, 'UTC')
      expect(b.getTime() - a.getTime()).toBe(86400000)
      // lp.jobs only claims rows with a next_run_at: it must be set, within a day.
      expect(job.next_run_at).toBeTruthy()
      expect(new Date(String(job.next_run_at)).getTime() - Date.now()).toBeLessThanOrEqual(86400000 + 60000)
    })

    it('the stray draft seed (kind with no runner handler) does not exist', async () => {
      const { rows } = await db.query(`select 1 from lp.jobs where name = 'sendtime_relearn' or kind = 'sendtime_recompute'`)
      expect(rows).toHaveLength(0)
    })

    it('the runner claims the seeded job, ops_call runs the op as the system actor, and windows are written', async () => {
      // Real clock here: the job runs the op with the current time.
      const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
      for (let d = 1; d <= 8; d++) {
        await db.query(
          `insert into lp.lead_events (type, company_id, contact_id, occurred_at, source) values ('email_link_clicked', $1, $2, $3::timestamptz, 'test')`,
          [companyId, contactId, `${day(d)}T14:05:00Z`],
        )
      }
      // Only the send-time job is due.
      await db.query(`update lp.jobs set next_run_at = now() + interval '1 day' where name <> 'sendtime_recompute'`)
      await db.query(`update lp.jobs set next_run_at = now() where name = 'sendtime_recompute'`)
      const calls: string[] = []
      const ops = async (op: string, args: Record<string, unknown>) => {
        calls.push(op)
        return runOp(db, 'system', op, args) // the runner's actor
      }
      const handlers = new Map([['ops_call', { handle: opsCallHandler.handle }]])
      const results = await pollOnce({ ops, handlers, runnerId: 'test-runner', claimLimit: 5 })
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('ok')
      expect(calls).toContain('sendtime_recompute')
      expect(results[0].output.result).toMatchObject({ recomputed: 1, skipped: 0 })
      // 14:05Z is 10:05 in summer (EDT) and 09:05 in winter (EST): the clock is real in this test.
      const stored = await getSendWindow(db, leadKey(companyId, contactId))
      expect([9, 10]).toContain(stored?.best_hour)
      expect(stored?.sample_size).toBe(8)
      const run = await db.query(`select status from lp.job_runs where job_name = 'sendtime_recompute'`)
      expect(run.rows[0]).toMatchObject({ status: 'ok' })
    })
  })
})
