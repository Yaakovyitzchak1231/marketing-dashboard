/**
 * Timezone validation. A timezone string reaches two places that behave very
 * differently on garbage: Postgres `at time zone $1` (an error that fails the
 * whole query) and Intl.DateTimeFormat (a RangeError). Validate once, here,
 * before either sees it.
 */
import { DEFAULT_TIMEZONE } from './config.ts'

// IANA names only ("Area/Location" or "UTC"). Offset forms like "+05:00" are
// rejected on purpose: Intl and Postgres read them with opposite signs.
const IANA_SHAPE = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !IANA_SHAPE.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export type TimezoneSource = 'lead' | 'default'

/**
 * A usable timezone and where it came from. `lead` = a valid timezone that
 * was supplied for this lead; `default` = we are assuming America/New_York
 * (nothing supplied, or what was supplied is not a real timezone). Callers
 * store and show the source, so an assumed ET is never presented as known.
 */
export function resolveTimezone(candidate: unknown): { timezone: string; timezone_source: TimezoneSource } {
  if (isValidTimezone(candidate)) return { timezone: candidate, timezone_source: 'lead' }
  return { timezone: DEFAULT_TIMEZONE, timezone_source: 'default' }
}
