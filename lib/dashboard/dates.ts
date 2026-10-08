/**
 * Calendar-date helpers for the dashboard's date ranges. Pure, no I/O.
 *
 * Instantly v2 analytics work in whole calendar days: a date-only start_date /
 * end_date pair is inclusive on both ends, and any time-of-day on a full ISO
 * timestamp is ignored (verified live 2026-10-08: start=end=2026-10-06 returned
 * that one day; 2026-10-06T12:00Z..2026-10-06T23:59Z returned the same day).
 * So the dashboard decides WHICH calendar days a range covers, in
 * DASHBOARD_TZ (default America/New_York), and sends them as YYYY-MM-DD.
 */
import type { DateRange, RangeKey } from '@/lib/dashboard/types'

export const DEFAULT_TZ = 'America/New_York'
export const RANGE_KEYS: readonly RangeKey[] = ['7d', '14d', '30d', '90d', 'all'] as const
export const RANGE_DAYS: Record<Exclude<RangeKey, 'all'>, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 }

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === 'string' && (RANGE_KEYS as readonly string[]).includes(v)
}

/** A valid IANA zone from env, else the default. Never throws. */
export function resolveTimezone(tz: string | undefined | null): string {
  const candidate = (tz || '').trim()
  if (!candidate) return DEFAULT_TZ
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch {
    return DEFAULT_TZ
  }
}

/** The calendar date (YYYY-MM-DD) that `instant` falls on in `timeZone`. */
export function dateInZone(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

/** Add whole days to a YYYY-MM-DD date (pure calendar math, no DST involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daysBetweenInclusive(start: string, end: string): number {
  const [ys, ms, ds] = start.split('-').map(Number)
  const [ye, me, de] = end.split('-').map(Number)
  return Math.round((Date.UTC(ye, me - 1, de) - Date.UTC(ys, ms - 1, ds)) / 86_400_000) + 1
}

/** Every date from start to end inclusive. */
export function eachDay(start: string, end: string): string[] {
  const n = daysBetweenInclusive(start, end)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(addDays(start, i))
  return out
}

/**
 * The range for a key: the last N calendar days in `timeZone`, today included.
 * 'all' has start null (all time).
 */
export function rangeFor(key: RangeKey, now: Date, timeZone: string): DateRange {
  const end = dateInZone(now, timeZone)
  if (key === 'all') return { key, start: null, end, timezone: timeZone }
  return { key, start: addDays(end, -(RANGE_DAYS[key] - 1)), end, timezone: timeZone }
}

/** The same-length period immediately before `range`, or null for all-time. */
export function previousRange(range: DateRange): DateRange | null {
  if (range.start === null) return null
  const len = daysBetweenInclusive(range.start, range.end)
  const end = addDays(range.start, -1)
  return { key: range.key, start: addDays(end, -(len - 1)), end, timezone: range.timezone }
}

/** Split [start, end] into consecutive windows of at most `maxDays` days. */
export function chunkRange(start: string, end: string, maxDays: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  let s = start
  while (s <= end) {
    const e0 = addDays(s, maxDays - 1)
    const e = e0 < end ? e0 : end
    out.push({ start: s, end: e })
    s = addDays(e, 1)
  }
  return out
}
