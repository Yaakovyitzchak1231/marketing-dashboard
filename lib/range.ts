/**
 * The reporting window.
 *
 * Defined once because it appears in two places that must never disagree: the
 * query the shell sends to the API, and the words under the page title. A
 * window is the kind of value that looks like a constant until someone changes
 * the query and forgets the label, at which point the dashboard claims to
 * cover a period it never fetched.
 */

/** Every window the API accepts. */
export type Range = '7d' | '30d' | '90d'

/** The default window: the last week. */
export const DEFAULT_RANGE: Range = '7d'

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
