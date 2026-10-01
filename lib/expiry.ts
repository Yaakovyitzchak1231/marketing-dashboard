/**
 * How far ahead the infrastructure view warns about expiring assets.
 *
 * This was a literal `14` in two places that must agree: the API route that
 * decides which domains are flagged, and the sentence under the heading that
 * tells the reader what the flag means. When those drift, the page warns
 * about one horizon and counts a different one, which is the exact class of
 * bug this project exists to prevent -- a number on screen that no query
 * produced.
 *
 * It is exported rather than inlined so the render path carries no numeric
 * literal (tests/no-fabrication.test.ts fails on those) and so a reviewer has
 * a single place to argue with the value.
 */
export const EXPIRY_WINDOW_DAYS = 14

/** Milliseconds in a day, for comparing against an expiry timestamp. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * True when `expiresAt` falls inside the warning window, counting from
 * `nowMs`.
 *
 * Takes the clock as a parameter rather than reading it internally so the
 * caller controls the snapshot: a page rendered from a cached fetch must
 * evaluate "expiring soon" against the same moment the rows were fetched,
 * not against whenever the browser happened to render.
 *
 * A null expiry is not expiring soon -- it is unknown, and unknown is a
 * different state that the table renders as a dash.
 */
export function isExpiringSoon(
  expiresAt: string | null,
  nowMs: number,
): boolean {
  if (expiresAt === null) return false
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return false
  return t - nowMs <= EXPIRY_WINDOW_DAYS * MS_PER_DAY
}