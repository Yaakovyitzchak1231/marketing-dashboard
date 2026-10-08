/**
 * Display formatting for the dashboard. Pure functions, no React.
 *
 * The rules (AGENTS.md, binding):
 *  - null means "Instantly did not report this" and renders as an em dash,
 *    never as 0 or 0%.
 *  - Rates arrive as 0..1 fractions already recomputed from raw counts by the
 *    data layer; this file only formats them (one decimal place).
 */

export const NOT_REPORTED = 'Not reported by Instantly'
export const DASH = '—'

/** 0.04237 -> "4.2%". null/NaN -> "—". */
export function formatPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return DASH
  return `${(rate * 100).toFixed(1)}%`
}

/** 12345 -> "12,345". null -> "—". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return Math.round(n).toLocaleString('en-US')
}

/** 1234.5 -> "$1,235". null -> "—". */
export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export type DeltaTone = 'good' | 'bad' | 'neutral'

export interface Delta {
  /** e.g. "+12%" or "+1.4 pts" */
  text: string
  tone: DeltaTone
  direction: 'up' | 'down' | 'flat'
}

/**
 * Change of a count vs the previous period, as a relative %.
 * Returns null when either side is unknown or the previous value is 0
 * (a % change from zero is undefined, not "+infinity%").
 */
export function countDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  higherIsBetter = true,
): Delta | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (previous === 0) return null
  const change = (current - previous) / previous
  const rounded = Math.round(change * 100)
  if (rounded === 0) return { text: '0%', tone: 'neutral', direction: 'flat' }
  const direction = rounded > 0 ? 'up' : 'down'
  const good = higherIsBetter ? direction === 'up' : direction === 'down'
  return { text: `${rounded > 0 ? '+' : ''}${rounded}%`, tone: good ? 'good' : 'bad', direction }
}

/**
 * Change of a rate vs the previous period, in percentage points
 * (4.0% -> 5.5% is "+1.5 pts", not "+37%").
 */
export function rateDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  higherIsBetter = true,
): Delta | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  const pts = Math.round((current - previous) * 1000) / 10
  if (pts === 0) return { text: '0 pts', tone: 'neutral', direction: 'flat' }
  const direction = pts > 0 ? 'up' : 'down'
  const good = higherIsBetter ? direction === 'up' : direction === 'down'
  return { text: `${pts > 0 ? '+' : ''}${pts.toFixed(1)} pts`, tone: good ? 'good' : 'bad', direction }
}

/** "Oct 8, 11:58 AM" in the given IANA timezone. */
export function formatUpdated(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }
}

/** "2026-10-08" -> "Oct 8" (no timezone shift: the date is already local to the range). */
export function formatDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`
}

export function rangeLabel(key: string): string {
  switch (key) {
    case '7d': return 'Last 7 days'
    case '14d': return 'Last 14 days'
    case '30d': return 'Last 30 days'
    case '90d': return 'Last 90 days'
    case 'all': return 'All time'
    default: return 'Custom range'
  }
}

/** "Oct 1 – Oct 8" or "All time to Oct 8". */
export function rangeSpan(start: string | null, end: string): string {
  return start ? `${formatDay(start)} – ${formatDay(end)}` : `All time to ${formatDay(end)}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}
