import { COPY } from '@/lib/copy'

/**
 * Display formatting.
 *
 * Every function here takes a value that may be `null`. `null` formats to the
 * "not reported" string or an em dash. None of these functions ever return '0' for
 * a null input — that substitution is the single defect this project exists to fix.
 */

export const UNAVAILABLE = COPY.metricUnavailable
export const EM_DASH = '—'

/** A number we have: 0.0419 -> "4.2%". A missing number -> the unavailable string. */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return UNAVAILABLE
  return `${(rate * 100).toFixed(digits)}%`
}

/**
 * Format a rate that may be impossible. A rate above 100% is rendered in full —
 * we do not clamp it, because the whole point is that the number is visibly wrong —
 * but it is always paired with the unreliable copy.
 */
export function formatPercentRaw(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return EM_DASH
  return `${(rate * 100).toFixed(digits)}%`
}

const intFmt = new Intl.NumberFormat('en-US')
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** An integer count, grouped. A missing count -> the unavailable string. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  return intFmt.format(n)
}

/** Currency, no cents. A missing value -> the unavailable string, never "$0". */
export function formatCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  return usdFmt.format(n)
}

/** "2026-09-28" -> "Sep 28". An unparseable date is returned as-is, never "Invalid Date". */
export function formatDay(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? '')
  if (!m) return dateStr
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
