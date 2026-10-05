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

/**
 * Every window the API accepts. Exported rather than re-typed at each
 * call site, so a control that offers a range and the validation that
 * accepts one cannot drift apart.
 */
const SUPPORTED_RANGES = ['7d', '30d', '90d'] as const

export type Range = (typeof SUPPORTED_RANGES)[number]

export const SUPPORTED_RANGE_KEYS = SUPPORTED_RANGES

/** The default window: the last week. */
export const DEFAULT_RANGE: Range = '7d'

/** How many days back the default window covers. */
export const DEFAULT_RANGE_DAYS = RANGE_DAYS

/**
 * The window the per-idea and per-angle performance views report over.
 *
 * Defined here, next to the range the shell uses, because these are two
 * different questions and they must not be conflated: DEFAULT_RANGE answers
 * "how is the account doing", PERFORMANCE_RANGE answers "which idea is
 * working", and the second needs enough history to rank things at all. A
 * one-week window cannot separate two ideas.
 *
 * The pages that show these views must import this rather than writing
 * `range=30d` inline: a literal in the render path is a number the database
 * never produced, which is precisely what tests/no-fabrication.test.ts fails
 * on. It is also how the query and the words under the title drift apart.
 */
export const PERFORMANCE_RANGE: Range = '30d'

/** Human label for the performance window, e.g. "last 30 days". */
export const PERFORMANCE_RANGE_LABEL = `last ${PERFORMANCE_RANGE.slice(0, -1)} days`

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
