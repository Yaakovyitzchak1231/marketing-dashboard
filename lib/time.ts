/**
 * The one time zone every server-rendered time on the dashboard is shown in.
 *
 * Vercel runs the server in UTC, so a bare `toLocaleString()` / `toLocaleDateString()` in a
 * server component prints UTC: a job that ran at 9:00 PM New York time read "1:00 AM" the next
 * day. Every human-facing time goes through here instead. DASHBOARD_TZ overrides the zone
 * (an invalid name falls back to America/New_York); the date-range code uses the same rule.
 */
import { resolveTimezone } from '@/lib/dashboard/dates'

export const APP_TIME_ZONE: string = resolveTimezone(typeof process !== 'undefined' ? process.env.DASHBOARD_TZ : undefined)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Format an instant in APP_TIME_ZONE. A date-only string ("2026-10-08") is a calendar day, not
 * an instant, so it is formatted as that day (no zone shift that would turn it into Oct 7).
 * Unparseable input returns the fallback, never "Invalid Date".
 */
export function formatInAppZone(value: Date | string | number | null | undefined, opts: Intl.DateTimeFormatOptions, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    const d = new Date(`${value}T12:00:00Z`)
    return Number.isNaN(d.getTime()) ? fallback : new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(d)
  }
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return fallback
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: APP_TIME_ZONE }).format(d)
}
