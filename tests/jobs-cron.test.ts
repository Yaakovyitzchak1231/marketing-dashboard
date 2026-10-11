import { describe, it, expect } from 'vitest'
import { nextRun, parseCron, CronError, assertValidTimezone } from '@/lib/jobs/cron'

const NY = 'America/New_York'

describe('parseCron: validation', () => {
  it('rejects the wrong number of fields', () => {
    expect(() => parseCron('* * * *')).toThrow(CronError)
    expect(() => parseCron('* * * * * *')).toThrow(CronError)
  })
  it('rejects an out-of-range value', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronError)
    expect(() => parseCron('* 24 * * *')).toThrow(CronError)
    expect(() => parseCron('* * 32 * *')).toThrow(CronError)
    expect(() => parseCron('* * * 13 *')).toThrow(CronError)
    expect(() => parseCron('* * * * 8')).toThrow(CronError)
  })
  it('rejects a bad step or an unknown name', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(CronError)
    expect(() => parseCron('* * * jun-smarch *')).toThrow(CronError)
    expect(() => parseCron('* * * * mon-tue-wed')).toThrow(CronError)
  })
  it('rejects an empty expression', () => {
    expect(() => parseCron('')).toThrow(CronError)
    expect(() => parseCron('   ')).toThrow(CronError)
  })
  it('rejects a reversed range', () => {
    expect(() => parseCron('10-5 * * * *')).toThrow(CronError)
  })
  it('accepts names (case-insensitive), lists, ranges and steps', () => {
    const p = parseCron('0,30 9-17 * JAN,jul MON-FRI')
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 30])
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...p.month].sort((a, b) => a - b)).toEqual([1, 7])
    expect([...p.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })
  it('treats dow 7 as Sunday (0)', () => {
    const p = parseCron('0 0 * * 7')
    expect([...p.dow]).toEqual([0])
  })
  it('rejects an unknown IANA timezone', () => {
    expect(() => assertValidTimezone('Mars/Olympus_Mons')).toThrow(CronError)
    expect(() => assertValidTimezone('America/New_York')).not.toThrow()
  })
})

describe('nextRun: basics', () => {
  it('every minute advances exactly one minute, strictly after `from`', () => {
    const r = nextRun('* * * * *', new Date('2026-01-01T00:00:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-01-01T00:01:00.000Z')
    // exactly on a minute boundary: still strictly AFTER, not equal to `from`
    const r2 = nextRun('* * * * *', new Date('2026-01-01T00:01:00Z'), 'UTC')
    expect(r2.toISOString()).toBe('2026-01-01T00:02:00.000Z')
  })
  it('a step schedule lands on the next step boundary', () => {
    const r = nextRun('*/15 * * * *', new Date('2026-01-01T00:16:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-01-01T00:30:00.000Z')
  })
  it('daily at a fixed local time, converted to UTC', () => {
    // EST in January: UTC-5, so 9am local = 14:00 UTC
    const r = nextRun('0 9 * * *', new Date('2026-01-01T00:00:00Z'), NY)
    expect(r.toISOString()).toBe('2026-01-01T14:00:00.000Z')
  })
  it('a job due right now (next_run_at == now) is found on the NEXT boundary, not re-offered immediately', () => {
    const r = nextRun('0 9 * * *', new Date('2026-01-01T14:00:00Z'), NY)
    expect(r.toISOString()).toBe('2026-01-02T14:00:00.000Z')
  })
})

describe('nextRun: day-of-month / day-of-week OR rule', () => {
  it('both restricted: matches the 15th OR a Monday, whichever comes first', () => {
    // 2026-01-01 is a Thursday. The first Monday is 2026-01-05; the 15th is later.
    const r = nextRun('0 0 15 * 1', new Date('2026-01-01T00:00:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })
  it('only day-of-month restricted (dow = *): only the day-of-month matters', () => {
    const r = nextRun('0 0 15 * *', new Date('2026-01-01T00:00:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-01-15T00:00:00.000Z')
  })
  it('only day-of-week restricted (dom = *): only the day-of-week matters', () => {
    // next Friday after 2026-01-01 (Thu) is 2026-01-02
    const r = nextRun('0 0 * * FRI', new Date('2026-01-01T00:00:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('nextRun: DST correctness (America/New_York, 2026 US rules)', () => {
  it('9am local stays 9am local across the spring-forward transition (Mar 8, 2026)', () => {
    const before = nextRun('0 9 * * *', new Date('2026-03-07T00:00:00Z'), NY) // EST, UTC-5
    const after = nextRun('0 9 * * *', new Date('2026-03-08T00:00:00Z'), NY) // EDT, UTC-4
    expect(before.toISOString()).toBe('2026-03-07T14:00:00.000Z')
    expect(after.toISOString()).toBe('2026-03-08T13:00:00.000Z')
  })
  it('a local time inside the spring-forward gap (2:30am on transition day) is never matched that year', () => {
    // 2:30am does not exist on 2026-03-08 in America/New_York (clocks jump 2am -> 3am).
    // The next real occurrence of "2:30am on March 8" is 2027 (not a transition day).
    const r = nextRun('30 2 8 3 *', new Date('2026-01-01T00:00:00Z'), NY)
    expect(r.getUTCFullYear()).toBe(2027)
    expect(r.toISOString()).toBe('2027-03-08T07:30:00.000Z') // EST (UTC-5) in effect on 2027-03-08
  })
  it('9am local stays 9am local across the fall-back transition (Nov 1, 2026)', () => {
    const before = nextRun('0 9 * * *', new Date('2026-10-31T00:00:00Z'), NY) // EDT, UTC-4
    const after = nextRun('0 9 * * *', new Date('2026-11-01T00:00:00Z'), NY) // EST, UTC-5
    expect(before.toISOString()).toBe('2026-10-31T13:00:00.000Z')
    expect(after.toISOString()).toBe('2026-11-01T14:00:00.000Z')
  })
  it('a fall-back ambiguous local time (1:30am occurs twice) is matched exactly once, not twice', () => {
    const first = nextRun('30 1 * * *', new Date('2026-11-01T00:00:00Z'), NY)
    const second = nextRun('30 1 * * *', first, NY)
    // second must be the NEXT day's 1:30am, not the same wall-clock time recurring within the same day
    expect(second.getTime() - first.getTime()).toBeGreaterThan(23 * 3600 * 1000)
  })
})

describe('nextRun: month restriction', () => {
  it('only runs in the given month(s)', () => {
    const r = nextRun('0 0 1 jun,dec *', new Date('2026-01-15T00:00:00Z'), 'UTC')
    expect(r.toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })
})
