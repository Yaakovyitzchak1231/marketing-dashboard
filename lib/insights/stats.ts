/**
 * Small, pure statistics and formatting helpers for the insights engine.
 * Rates are always computed from raw counts here; nothing averages a rate.
 */
import { CONFIDENCE_Z } from './thresholds'

/** k / n, or null when either is null, n <= 0, or the result is not a real rate (k < 0 or k > n). */
export function rate(k: number | null | undefined, n: number | null | undefined): number | null {
  if (k == null || n == null || !Number.isFinite(k) || !Number.isFinite(n)) return null
  if (n <= 0 || k < 0 || k > n) return null
  return k / n
}

/**
 * Wilson score interval for a binomial proportion k of n at z (default 95%).
 * Used so a 2-of-5 campaign (40%, interval ~12%..77%) never outranks 40-of-1000
 * (4%, interval ~3.0%..5.4%) on its lucky point estimate.
 * Returns null when the rate is undefined (see `rate`).
 */
export function wilson(
  k: number | null | undefined,
  n: number | null | undefined,
  z: number = CONFIDENCE_Z,
): { lower: number; upper: number } | null {
  const p = rate(k, n)
  if (p == null || n == null) return null
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) }
}

/**
 * Two-proportion z statistic (pooled), k1/n1 vs k2/n2. Positive when the first
 * is higher. null when undefined or when both rates are 0 or both 1 (no variance).
 */
export function twoProportionZ(
  k1: number | null, n1: number | null,
  k2: number | null, n2: number | null,
): number | null {
  const p1 = rate(k1, n1)
  const p2 = rate(k2, n2)
  if (p1 == null || p2 == null || n1 == null || n2 == null || k1 == null || k2 == null) return null
  const pooled = (k1 + k2) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se === 0) return null
  return (p1 - p2) / se
}

/** True when |z| clears the 95% two-sided bar. */
export function significant(z: number | null): boolean {
  return z != null && Math.abs(z) >= CONFIDENCE_Z
}

/** Median of a non-empty numeric list (copy-sorted). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ---------- formatting (deterministic: fixed en-US) ---------- */

/** 0.0412 -> "4.1%"; values under 1% keep two decimals ("0.45%"); 0 -> "0%". */
export function pct(x: number): string {
  if (x === 0) return '0%'
  const v = x * 100
  const digits = Math.abs(v) < 1 ? 2 : 1
  return `${trimZeros(v.toFixed(digits))}%`
}

/** Percentage-point difference, signed: 0.012 -> "+1.2 pts". */
export function pts(diff: number): string {
  const v = diff * 100
  const digits = Math.abs(v) < 1 ? 2 : 1
  const s = trimZeros(Math.abs(v).toFixed(digits))
  return `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${s} pts`
}

/** 12345 -> "12,345". */
export function num(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** "12 of 290" */
export function ofN(k: number, n: number): string {
  return `${num(k)} of ${num(n)}`
}

/** 1 -> "1 day", 3 -> "3 days", 0.4 -> "under a day". */
export function days(d: number): string {
  if (d < 1) return 'under a day'
  const r = Math.floor(d)
  return `${r} day${r === 1 ? '' : 's'}`
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}
