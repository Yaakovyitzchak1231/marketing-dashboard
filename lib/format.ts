/**
 * Formatting primitives for every figure the dashboard renders.
 *
 * The rule these exist to enforce (AGENTS.md, first rule): a number on screen
 * must have come from a stored row or a named API response. When the API did
 * not report a metric, we render `UNAVAILABLE` -- never 0, never "0.0%", never
 * a placeholder that reads as a value.
 *
 * `null` means "the API did not say." `0` is a measurement. These functions are
 * the single place that distinction is made, so a null can never be coerced
 * into a zero somewhere downstream.
 */

/** Rendered in place of a metric the source did not provide. */
export const UNAVAILABLE = '—'

/**
 * True when a value cannot be shown because the source did not report it.
 * Note that 0 is NOT unavailable: a zero is a real measurement.
 *
 * Declared as a type predicate so that under `strict` a `!isUnavailable(v)`
 * check narrows `v` for TypeScript, not just at runtime.
 */
export function isUnavailable(
  value: number | string | null | undefined,
): value is null | undefined {
  return value === null || value === undefined
}

/**
 * Thousands-separated integer. A null renders as UNAVAILABLE, never "0".
 */
export function formatCount(value: number | null | undefined): string {
  if (isUnavailable(value)) return UNAVAILABLE
  if (!Number.isFinite(value)) return UNAVAILABLE
  return Math.round(value).toLocaleString('en-US')
}

/**
 * A rate expressed as a fraction (0.05) rendered as a percentage ("5.0%").
 *
 * A null renders as UNAVAILABLE. This is deliberate and load-bearing: the
 * Instantly API does not populate open rate, and a null that rendered as
 * "0.0%" is precisely the bug this dashboard was built to fix.
 */
export function formatRate(
  value: number | null | undefined,
  digits = 1,
): string {
  if (isUnavailable(value)) return UNAVAILABLE
  if (!Number.isFinite(value)) return UNAVAILABLE
  return `${(value * 100).toFixed(digits)}%`
}

/** Currency, whole dollars. A null renders as UNAVAILABLE. */
export function formatCurrency(value: number | null | undefined): string {
  if (isUnavailable(value)) return UNAVAILABLE
  if (!Number.isFinite(value)) return UNAVAILABLE
  return `$${Math.round(value).toLocaleString('en-US')}`
}

/**
 * The highest value a rate can take and still be a rate. Anything above this
 * is a denominator error -- in this project, the autoresponder bug that
 * produced 333% and 450%.
  *
  * Named and exported rather than inlined at each call site so a reviewer can
  * find it and argue with it, and so the "no numbers in the render path" test
  * has nothing to flag.
  */
 export const MAX_PLAUSIBLE_RATE = 1

 /**
  * True when a rate is a rate the source could actually have measured.
  *
  * A null returns TRUE: it is unreported, not implausible. Conflating the two
  * would make a component label "not reliable" for a metric the API simply
  * never populates, which is a different and wrong claim. Callers handle
  * missing with `isUnavailable` and impossible with this.
  */
 export function rateIsPlausible(value: number | null | undefined): boolean {
   if (isUnavailable(value)) return true
   return (value as number) <= MAX_PLAUSIBLE_RATE
 }

 /**
  * A percentage-point value (86.4) rendered as a percentage ("86.4%").
  *
  * This is a unit conversion of a number the source reported, not a second
  * measurement, and it is the only sanctioned way to do it -- a raw `* 100` in
  * a component is a recomputed figure and the fabrication test fails on it.
  */
 export function formatPercentagePoints(
   value: number | null | undefined,
   digits = 1,
 ): string {
   if (isUnavailable(value)) return UNAVAILABLE
   if (!Number.isFinite(value)) return UNAVAILABLE
   return `${value.toFixed(digits)}%`
 }

 /**
  * True only for a measured zero. A null is NOT zero -- this exists so a
  * component can grey out a genuine "0 not healthy" without also greying out
  * an unreported count.
  */
 export function countIsZero(value: number | null | undefined): boolean {
   return value === 0
 }

 /** ISO date string to a short human date. Anything unparseable renders as
 * UNAVAILABLE rather than "Invalid Date". */
export function formatDate(value: string | null | undefined): string {
  if (isUnavailable(value)) return UNAVAILABLE
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return UNAVAILABLE
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
