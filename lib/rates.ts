/**
 * Rate arithmetic, in one place.
 *
 * Every route computes rates through `rateFrom` so the number, the trust flag
 * and the reason string cannot disagree between /api/overview, /api/campaigns
 * and the trend endpoint. If these rules are duplicated per route they will
 * drift, and the UI will end up rendering a number the API called untrusted.
 *
 * Rules, in priority order:
 *
 *  1. NULL in, NULL out. A missing count is never coerced to 0. "We did not
 *     measure this" is not "the answer is zero".
 *  2. A rate above 100% is a bug, never a real result. If the numerator
 *     exceeds the denominator the rate is NULL, not the computed number.
 *  3. Never average a rate. Always recompute from raw counts.
 *
 * On the 100% ceiling: this is not a presentational clamp. Live data has
 * campaigns reporting 9 unique replies from 2 sends, which is arithmetically
 * impossible. Rather than clamp it to 100% (a claim) we suppress it and record
 * why, so the row can say "Not reported by Instantly" instead of lying.
 */

/** Minimum sends before a rate is treated as meaningful. Product decision. */
export const MIN_SENDS_FOR_TRUST = 1

export interface RateInput {
  /** Raw numerator, e.g. replies_unique. null = not collected. */
  numerator: number | null
  /** Raw denominator, e.g. emails_sent. null = not collected. */
  denominator: number | null
  /** Which field was used as the denominator, stored for traceability. */
  denominatorSource: string
  /** TRUE when this row came from a partial or failed collection. */
  partial?: boolean
  /** Collector error stage naming this row, if any. */
  errorReason?: string | null
}

export interface RateResult {
  /** The rate as a fraction (0.0421 = 4.21%), or null when not computable. */
  value: number | null
  denominator: number | null
  denominatorSource: string
  /** Drives @build-copy's trusted / untrusted copy split. */
  trusted: boolean
  /** null when trusted. */
  reason: string | null
}

export function rateFrom(input: RateInput): RateResult {
  const { numerator, denominator, denominatorSource } = input
  const base = { denominator, denominatorSource }

  // A failed collection outranks every arithmetic concern: we did not get to
  // measure this row, so nothing derived from it is trustworthy.
  if (input.partial || input.errorReason) {
    return {
      ...base,
      value: null,
      trusted: false,
      reason: input.errorReason ?? 'collector_error',
    }
  }

  if (numerator === null || denominator === null) {
    return { ...base, value: null, trusted: false, reason: 'not_collected' }
  }

  if (denominator <= 0) {
    return { ...base, value: null, trusted: false, reason: 'no_sends' }
  }

  // The impossible case. Instantly reports more unique replies than it can
  // have sent on this account; suppress rather than publish a >100% figure.
  if (numerator > denominator) {
    return {
      ...base,
      value: null,
      trusted: false,
      reason: 'numerator_exceeds_denominator',
    }
  }

  if (denominator < MIN_SENDS_FOR_TRUST) {
    return { ...base, value: null, trusted: false, reason: 'insufficient_sends' }
  }

  return {
    ...base,
    value: Math.round((numerator / denominator) * 10000) / 10000,
    trusted: true,
    reason: null,
  }
}

/**
 * Reads Instantly's open/unsubscribe metrics.
 *
 * Instantly returns 0 for `open_count_unique` on all 8 campaigns and on the
 * account overview. That 0 is a metric it never measured, not a measurement of
 * zero. `open_reported` is FALSE for this account, so the API must return null
 * even though the stored count is 0.
 *
 * Never widen this to "if the number is falsy return null": a genuine 0 opens
 * would then be suppressed too. The signal is the reported flag, which comes
 * from the collector's own knowledge of what the API populated.
 */
export function openRateFrom(input: {
  opensUnique: number | null
  reported: boolean
  denominator: number | null
}): number | null {
  const { opensUnique, reported, denominator } = input
  if (!reported) return null
  if (opensUnique === null || !denominator || denominator <= 0) return null
  if (opensUnique > denominator) return null
  return Math.round((opensUnique / denominator) * 10000) / 10000
}

export function unsubRateFrom(input: {
  unsubscribed: number | null
  reported: boolean
  denominator: number | null
}): number | null {
  const { unsubscribed, reported, denominator } = input
  if (!reported) return null
  if (unsubscribed === null || !denominator || denominator <= 0) return null
  if (unsubscribed > denominator) return null
  return Math.round((unsubscribed / denominator) * 10000) / 10000
}
