/**
 * Quiet-hours setting keys. Kept in a plain module (not the 'use client'
 * QuietHoursField) so the server-rendered Settings page reads real strings:
 * a constant exported from a client module reaches server code as a client
 * reference, not its value, and the page then fell back to two text rows.
 */
export const QUIET_START_KEY = 'workspace.quiet_hours_start'
export const QUIET_END_KEY = 'workspace.quiet_hours_end'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function blank(v: unknown): boolean {
  return v == null || (typeof v === 'string' && !v.trim())
}

/**
 * The quiet-hours pair is one range, so it is judged as a pair: both blank (no quiet
 * hours), or both set, each 24-hour HH:MM, and different. Returns a message naming the
 * two settings, or null when the pair is sound. Pure, so the settings writers, the
 * Settings page and the send gate (lib/journeys/send-controls.ts) all use one rule.
 */
export function quietHoursPairError(start: unknown, end: unknown): string | null {
  const keys = `${QUIET_START_KEY} and ${QUIET_END_KEY}`
  if (blank(start) && blank(end)) return null
  if (blank(start) || blank(end)) {
    return `Quiet hours need both a start and an end (${keys}); only one is set. Set both, or neither.`
  }
  if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start.trim()) || !HHMM.test(end.trim())) {
    return `Quiet hours (${keys}) must each be 24-hour HH:MM, e.g. 21:00.`
  }
  if (start.trim() === end.trim()) {
    return `Quiet hours start and end (${keys}) are the same time, so there would be no quiet hours. Make them different.`
  }
  return null
}
