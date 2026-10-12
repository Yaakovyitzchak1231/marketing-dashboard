import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import {
  computeSendWindow,
  getSendWindow,
  leadKey,
  pickWindow,
  recomputeSendWindow,
  recomputeSendWindows,
  DEFAULT_TIMEZONE,
  MIN_SAMPLE,
  SendTimeError,
  type SendWindow,
} from '@/lib/sendtime/analyze'
import { optimalSendAt, resolveSendTime } from '@/lib/sendtime/schedule'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// The shared box is slow; PGlite boots a full Postgres per test.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })

const MON_11AM_EDT = new Date('2026-10-12T15:00:00Z') // Monday, 11:00 AM EDT

function win(over: Partial<SendWindow> = {}): SendWindow {
  return {
    lead_key: 'company:1',
    best_hour: 10,
    best_dow: null,
    timezone: 'America/New_York',
    sample_size: 20,
    updated_at: new Date(),
    ...over,
  }
}

describe('pickWindow (pure bucketing)', () => {
  it('picks the hour with the most engagement', () => {
    const w = pickWindow(
      [
        { h: 9, dow: 1, n: 2 },
        { h: 10, dow: 1, n: 8 },
        { h: 14, dow: 2, n: 3 },
      ],
      DEFAULT_TIMEZONE,
      'company:1',
    )
    expect(w?.best_hour).toBe(10)
    expect(w?.sample_size).toBe(13)
  })
  it('returns null below the minimum sample', () => {
    expect(pickWindow([{ h: 10, dow: 1, n: MIN_SAMPLE - 1 }], DEFAULT_TIMEZONE, 'company:1')).toBeNull()
  })
  it('sets best_dow only when one day clearly wins', () => {
    const concentrated = pickWindow(
      [
        { h: 10, dow: 2, n: 12 },
        { h: 10, dow: 3, n: 1 },
        { h: 10, dow: 4, n: 1 },
      ],
      DEFAULT_TIMEZONE,
      'company:1',
    )
    expect(concentrated?.best_dow).toBe(2)
    const flat = pickWindow(
      [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ h: 10, dow, n: 2 })),
      DEFAULT_TIMEZONE,
      'company:1',
    )
    expect(flat?.best_dow).toBeNull()
  })
})

describe('leadKey', () => {
  it('prefers the contact when present', () => {
    expect(leadKey(7, 9)).toBe('contact:9')
    expect(leadKey(7, null)).toBe('company:7')
  })
  it('rejects empty input', () => {
    expect(() => leadKey(null, null)).toThrow(SendTimeError)
  })
})

describe('optimalSendAt (pure date math)', () => {
  it('moves a past-today window to tomorrow at best_hour', () => {
    // 11:00 AM EDT is past the 10 AM window: next is Tue 10:00 AM EDT = 14:00 UTC
    const out = optimalSendAt(win(), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-13T14:00:00.000Z')
  })
  it('keeps today when the window is still ahead', () => {
    const out = optimalSendAt(win(), new Date('2026-10-12T13:00:00Z')) // 9:00 AM EDT
    expect(out.toISOString()).toBe('2026-10-12T14:00:00.000Z')
  })
  it('prefers the best day of week within the next 7 days', () => {
    // best_dow = 3 (Wednesday); Monday 11 AM -> Wednesday 10 AM EDT
    const out = optimalSendAt(win({ best_dow: 3 }), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-14T14:00:00.000Z')
  })
  it('never returns a time in the past', () => {
    const out = optimalSendAt(win({ best_hour: 23 }), MON_11AM_EDT)
    expect(out.getTime()).toBeGreaterThanOrEqual(MON_11AM_EDT.getTime())
  })
  it('clamps a 3am best hour into business hours (8am local)', () => {
    // Monday 11 AM EDT, best_hour 3 -> clamped to 8 AM; 8 AM already passed, so Tue 8 AM EDT = 12:00 UTC
    const out = optimalSendAt(win({ best_hour: 3 }), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-13T12:00:00.000Z')
  })
  it('clamps a late-night best hour to 6pm local', () => {
    // Monday 11 AM EDT, best_hour 23 -> clamped to 18:00 EDT today = 22:00 UTC
    const out = optimalSendAt(win({ best_hour: 23 }), MON_11AM_EDT)
    expect(out.toISOString()).toBe('2026-10-12T22:00:00.000Z')
  })
  it('falls back to the due time when the shift exceeds 48 hours', () => {
    // best_dow = Sunday (0); Monday 11 AM -> Sunday 10 AM is ~6 days out, over the cap
    const out = optimalSendAt(win({ best_dow: 0 }), MON_11AM_EDT)
    expect(out.getTime()).toBe(MON_11AM_EDT.getTime())
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

  async function engage(at: string, type = 'email_opened', contact = true) {
    await db.query(
      `insert into lp.lead_events (type, company_id, contact_id, occurred_at, source) values ($1, $2, $3, $4::timestamptz, 'test')`,
      [type, companyId, contact ? contactId : null, at],
    )
  }

  it('learns the best hour from engagement history', async () => {
    // 10:00 AM EDT = 14:00 UTC; sprinkle a few elsewhere
    for (let d = 5; d <= 10; d++) await engage(`2026-10-0${d}T14:05:00Z`)
    await engage('2026-10-06T18:05:00Z')
    await engage('2026-10-07T03:05:00Z')
    const key = leadKey(companyId, contactId)
    const computed = await computeSendWindow(db, key)
    expect(computed?.best_hour).toBe(10)
    expect(computed?.sample_size).toBe(8)
    const stored = await recomputeSendWindow(db, key)
    expect(stored).toMatchObject({ lead_key: key, best_hour: 10 })
    expect(await getSendWindow(db, key)).toMatchObject({ best_hour: 10 })
  })

  it('leaves the row alone when there is not enough evidence', async () => {
    await engage('2026-10-06T14:05:00Z')
    const key = leadKey(companyId, contactId)
    expect(await recomputeSendWindow(db, key)).toBeNull()
    expect(await getSendWindow(db, key)).toBeNull()
  })

  it('resolveSendTime shifts into the window, or passes through without one', async () => {
    for (let d = 5; d <= 10; d++) await engage(`2026-10-0${d}T14:05:00Z`)
    const key = leadKey(companyId, contactId)
    await recomputeSendWindow(db, key)
    const shifted = await resolveSendTime(db, companyId, contactId, MON_11AM_EDT)
    expect(shifted.shifted).toBe(true)
    expect(shifted.send_at.toISOString()).toBe('2026-10-13T14:00:00.000Z')

    const company2 = await addCompany(db, { name: 'No History Co' })
    const passthrough = await resolveSendTime(db, company2, null, MON_11AM_EDT)
    expect(passthrough).toMatchObject({ shifted: false, window: null })
    expect(passthrough.send_at).toEqual(MON_11AM_EDT)
  })

  it('recomputeSendWindows covers leads with recent engagement', async () => {
    for (let d = 5; d <= 10; d++) await engage(`2026-10-0${d}T14:05:00Z`)
    const r = await recomputeSendWindows(db, {})
    expect(r.recomputed).toBe(1)
    expect(r.skipped).toBe(0)
  })
})
