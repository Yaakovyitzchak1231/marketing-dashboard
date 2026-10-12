/**
 * Postgres error classification shared by every "has this table migrated yet?"
 * fallback (review fix, Instinct #86 finding 2).
 *
 * The old helpers matched the message text /does not exist/, which is also what
 * Postgres says for a missing COLUMN (42703), FUNCTION (42883), schema (3F000),
 * type (42704) or constraint. Those are real bugs (a bad query, a half-applied
 * migration), not "this deploy hasn't run migration N yet", and swallowing them
 * made the profile, files, score and segment cards silently show empty data.
 *
 * Only SQLSTATE 42P01 (undefined_table: "relation ... does not exist") means a
 * table is missing. node-postgres (prod) and PGlite (tests) both put the
 * SQLSTATE on `err.code`; a wrapper that rethrows with `{ cause }` is followed.
 * The message is deliberately NOT consulted: an error with no SQLSTATE is not a
 * Postgres "table missing" error and is rethrown by callers.
 *
 * No 'server-only' import here, so client-safe and test-safe.
 */

/** SQLSTATE for undefined_table ("relation ... does not exist"). */
export const PG_UNDEFINED_TABLE = '42P01'

/** The SQLSTATE on a Postgres error (or on its `cause` chain, up to 5 levels), or null. */
export function pgErrorCode(e: unknown): string | null {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur != null && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/** True only for Postgres' undefined_table (42P01): the table hasn't migrated on this database yet. */
export function isUndefinedTable(e: unknown): boolean {
  return pgErrorCode(e) === PG_UNDEFINED_TABLE
}
