/**
 * The reporting window.
 *
 * Defined once because it appears in two places that must never disagree: the
 * query the shell sends to the API, and the words under the page title. A
 * window is the kind of value that looks like a constant until someone changes
 * the query and forgets the label, at which point the dashboard claims to
 * cover a period it never fetched.
 *
 * The value is validated against the API's accepted values so an unsupported
 * window fails loudly here rather than silently falling back to a default
 * inside the route handler.
 */
const RANGE_DAYS = 7

const SUPPORTED_RANGES = ['7d', '30d', '90d'] as const

export type Range = (typeof SUPPORTED_RANGES)[number]

/** The default window: the last week. */
export const DEFAULT_RANGE: Range = '7d'

/** How many days back the default window covers. */
export const DEFAULT_RANGE_DAYS = RANGE_DAYS

/**
 * A short human label for the window, e.g. "last 7 days".
 *
 * @build-copy owns the phrasing; the number comes from here so it cannot drift
 * out of step with the query the shell actually sends.
 */
export const RANGE_LABEL = `last ${RANGE_DAYS} days`

/** True when a string is a window the API accepts. */
export function isSupportedRange(value: string): value is Range {
  return (SUPPORTED_RANGES as readonly string[]).includes(value)
}
