/**
 * Plan 3.10: when a journey may send to a lead.
 *
 * Quiet hours and send windows are lead-local. launch_at and active_until are
 * absolute. Row 3.9 calls sendAllowed before any send and waits or skips from
 * the result. This module does not send.
 */

const FALLBACK_TZ = 'America/New_York'
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const MINUTE = 60_000

export interface ClockWindow {
  start: string
  end: string
}

export interface SendWindow extends ClockWindow {
  days: number[]
}

export interface SendControls {
  quiet_hours?: ClockWindow | null
  fallback_timezone?: string | null
  send_window?: SendWindow | null
  launch_at?: string | null
  active_until?: string | null
}

export interface SendAllowedInput {
  contactTimezone?: string | null
  companyTimezone?: string | null
  controls?: SendControls | null
  /** workspace.quiet_hours_start / end, used when the journey sets none. */
  workspaceQuietHours?: ClockWindow | null
}

export type SendDecision =
  | { allow: true }
  | { allow: false; until: Date; reason: 'before launch' | 'quiet hours' | 'send window' }
  | { allow: false; until: null; reason: 'past active-until' }

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function validTz(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function pickTz(raw: string | null | undefined): string | null {
  const tz = typeof raw === 'string' ? raw.trim() : ''
  return tz && validTz(tz) ? tz : null
}

/** Contact, then company, then the journey fallback, then America/New_York. */
export function resolveLeadTimezone(input: {
  contactTimezone?: string | null
  companyTimezone?: string | null
  fallbackTimezone?: string | null
}): string {
  return pickTz(input.contactTimezone)
    ?? pickTz(input.companyTimezone)
    ?? pickTz(input.fallbackTimezone)
    ?? FALLBACK_TZ
}

function minutesOf(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function clock(raw: ClockWindow | null | undefined): { start: number; end: number } | null {
  if (!raw) return null
  const start = minutesOf(raw.start)
  const end = minutesOf(raw.end)
  if (start == null || end == null || start === end) return null
  return { start, end }
}

function windowOf(raw: SendWindow | null | undefined): { days: number[]; start: number; end: number } | null {
  const span = clock(raw)
  if (!span || !raw) return null
  const days = [...new Set((raw.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
  if (!days.length) return null
  return { days, ...span }
}

function instant(raw: string | null | undefined): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms) : null
}

interface LocalParts {
  y: number
  m: number
  d: number
  dow: number
  minutes: number
}

function localParts(date: Date, tz: string): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
  let hour = Number(parts.hour)
  if (hour === 24) hour = 0
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    dow: DOW[parts.weekday] ?? 0,
    minutes: hour * 60 + Number(parts.minute),
  }
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60)
  return asUtc - date.getTime()
}

function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60))
  const first = offsetMs(guess, tz)
  let result = new Date(guess.getTime() - first)
  const second = offsetMs(result, tz)
  if (second !== first) result = new Date(guess.getTime() - second)
  return result
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function afterBoundary(date: Date): Date {
  return new Date(date.getTime() + MINUTE)
}

function inSpan(minutes: number, start: number, end: number): boolean {
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

function quietEnd(now: Date, tz: string, start: number, end: number): Date {
  const p = localParts(now, tz)
  const tomorrow = start > end && p.minutes >= start
  const day = addDays(p.y, p.m, p.d, tomorrow ? 1 : 0)
  return afterBoundary(zonedToUtc(day.y, day.m, day.d, end, tz))
}

function nextWindowOpen(now: Date, tz: string, days: number[], start: number): Date {
  const p = localParts(now, tz)
  for (let i = 0; i < 8; i++) {
    const dow = (p.dow + i) % 7
    if (!days.includes(dow)) continue
    if (i === 0 && p.minutes >= start) continue
    const day = addDays(p.y, p.m, p.d, i)
    return afterBoundary(zonedToUtc(day.y, day.m, day.d, start, tz))
  }
  const day = addDays(p.y, p.m, p.d, 7)
  return afterBoundary(zonedToUtc(day.y, day.m, day.d, start, tz))
}

function inSendWindow(now: Date, tz: string, days: number[], start: number, end: number): boolean {
  const p = localParts(now, tz)
  if (start < end) return days.includes(p.dow) && inSpan(p.minutes, start, end)
  const prev = (p.dow + 6) % 7
  return (days.includes(p.dow) && p.minutes >= start) || (days.includes(prev) && p.minutes < end)
}

/** Pull settings.send_controls. Missing or junk fields are unset, not errors. */
export function readSendControls(settings: unknown): SendControls {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {}
  const raw = (settings as Record<string, unknown>).send_controls
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as SendControls
}

/**
 * May a send go out at `now`? A hold's `until` is one minute past the boundary
 * so the next look is strictly after it. Past active-until is a skip, not a wait.
 */
export function sendAllowed(now: Date, input: SendAllowedInput): SendDecision {
  const controls = input.controls ?? {}
  const tz = resolveLeadTimezone({
    contactTimezone: input.contactTimezone,
    companyTimezone: input.companyTimezone,
    fallbackTimezone: controls.fallback_timezone,
  })
  const launch = instant(controls.launch_at)
  if (launch && now.getTime() < launch.getTime()) {
    return { allow: false, until: afterBoundary(launch), reason: 'before launch' }
  }
  const activeUntil = instant(controls.active_until)
  if (activeUntil && now.getTime() >= activeUntil.getTime()) {
    return { allow: false, until: null, reason: 'past active-until' }
  }

  const quiet = clock(controls.quiet_hours) ?? clock(input.workspaceQuietHours)
  const window = windowOf(controls.send_window)
  const holds: { until: Date; reason: 'quiet hours' | 'send window' }[] = []
  if (quiet && inSpan(localParts(now, tz).minutes, quiet.start, quiet.end)) {
    holds.push({ until: quietEnd(now, tz, quiet.start, quiet.end), reason: 'quiet hours' })
  }
  if (window && !inSendWindow(now, tz, window.days, window.start, window.end)) {
    holds.push({ until: nextWindowOpen(now, tz, window.days, window.start), reason: 'send window' })
  }
  if (!holds.length) return { allow: true }
  holds.sort((a, b) => a.until.getTime() - b.until.getTime())
  return { allow: false, until: holds[0].until, reason: holds[0].reason }
}
