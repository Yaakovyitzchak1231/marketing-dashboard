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
/** An ISO date-time with a time and an explicit offset or Z. Offset-less values would be read in the server's zone. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const MINUTE = 60_000
/** How long a send waits before looking again when the journey's send controls are malformed. */
const INVALID_RETRY_MS = 60 * MINUTE
/** Safety cap on the "next instant everything allows" search; a week of alternating holds needs far fewer. */
const MAX_HOLD_STEPS = 64

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
  /**
   * settings.send_controls as stored. Deliberately `unknown`: it is jsonb and may be malformed,
   * and sendAllowed checks every field itself. A malformed field holds the send; it never lifts a limit.
   */
  controls?: unknown
  /** workspace.quiet_hours_start / end, used when the journey sets none. */
  workspaceQuietHours?: ClockWindow | null
}

/**
 * `timezone_defaulted` is present (and true) when no contact, company or journey zone was usable
 * and the house default America/New_York was applied, so the fallback is never silent.
 */
type Flags = { timezone_defaulted?: true }

export type HoldReason = 'before launch' | 'quiet hours' | 'send window'
export type InvalidReason = 'invalid send window' | 'invalid send controls'

export type SendDecision =
  | ({ allow: true } & Flags)
  | ({ allow: false; until: Date; reason: HoldReason } & Flags)
  | ({ allow: false; until: Date; reason: InvalidReason; errors: string[] } & Flags)
  | ({ allow: false; until: null; reason: 'past active-until' } & Flags)

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// One formatter per zone: building an Intl.DateTimeFormat is far costlier than using one.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let dtf = formatters.get(tz)
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatters.set(tz, dtf)
  }
  return dtf
}

function validTz(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false
  try {
    formatterFor(tz)
    return true
  } catch {
    return false
  }
}

function pickTz(raw: unknown): string | null {
  const tz = typeof raw === 'string' ? raw.trim() : ''
  return tz && validTz(tz) ? tz : null
}

/** The zone and whether it was the house default (America/New_York) because nothing usable was supplied. Never throws. */
export function resolveLeadTimezoneDetail(input: {
  contactTimezone?: string | null
  companyTimezone?: string | null
  fallbackTimezone?: string | null
}): { timezone: string; defaulted: boolean } {
  const picked = pickTz(input.contactTimezone) ?? pickTz(input.companyTimezone) ?? pickTz(input.fallbackTimezone)
  return picked ? { timezone: picked, defaulted: false } : { timezone: FALLBACK_TZ, defaulted: true }
}

/** Contact, then company, then the journey fallback, then America/New_York. */
export function resolveLeadTimezone(input: {
  contactTimezone?: string | null
  companyTimezone?: string | null
  fallbackTimezone?: string | null
}): string {
  return resolveLeadTimezoneDetail(input).timezone
}

function minutesOf(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

type Span = { start: number; end: number }
type DayWindow = Span & { days: number[] }
type Field = 'send_controls' | 'quiet_hours' | 'send_window' | 'launch_at' | 'active_until' | 'fallback_timezone' | 'workspace_quiet_hours'
type Problem = { field: Field; message: string }

function checkSpan(raw: unknown, field: Field, label: string, problems: Problem[]): Span | null {
  if (!isObject(raw)) {
    problems.push({ field, message: `${label} must be {start, end} in 24-hour HH:MM` })
    return null
  }
  const start = minutesOf(raw.start)
  const end = minutesOf(raw.end)
  if (start == null) problems.push({ field, message: `${label}.start must be 24-hour HH:MM with two digits, e.g. "09:00"` })
  if (end == null) problems.push({ field, message: `${label}.end must be 24-hour HH:MM with two digits, e.g. "17:00"` })
  if (start == null || end == null) return null
  if (start === end) {
    problems.push({ field, message: `${label}.start and end must differ (a start later than the end wraps midnight)` })
    return null
  }
  return { start, end }
}

function checkWindow(raw: unknown, problems: Problem[]): DayWindow | null {
  const before = problems.length
  const span = checkSpan(raw, 'send_window', 'send_window', problems)
  const rawDays = isObject(raw) ? raw.days : undefined
  let days: number[] = []
  if (!Array.isArray(rawDays)) {
    problems.push({ field: 'send_window', message: 'send_window.days must be an array of integers 0 (Sunday) to 6 (Saturday)' })
  } else if (!rawDays.length) {
    problems.push({ field: 'send_window', message: 'send_window.days must list at least one day' })
  } else if (!rawDays.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
    problems.push({ field: 'send_window', message: 'send_window.days must be integers 0 (Sunday) to 6 (Saturday), not strings or other values' })
  } else {
    days = [...new Set(rawDays as number[])]
  }
  if (problems.length > before || !span) return null
  return { days, ...span }
}

function checkInstant(raw: unknown, field: 'launch_at' | 'active_until', problems: Problem[]): Date | null {
  if (typeof raw !== 'string' || !INSTANT_RE.test(raw.trim()) || !Number.isFinite(Date.parse(raw.trim()))) {
    problems.push({
      field,
      message: `${field} must be an ISO date-time with an explicit offset or Z, e.g. "2026-10-14T13:00:00Z" or "2026-10-14T09:00:00-04:00"`,
    })
    return null
  }
  return new Date(Date.parse(raw.trim()))
}

interface Inspected {
  problems: Problem[]
  quiet: Span | null
  window: DayWindow | null
  launch: Date | null
  activeUntil: Date | null
  fallbackTimezone: unknown
}

/**
 * Check every field of send_controls. Absent (undefined or null) is "no such control";
 * present but malformed is a problem, never a silent "no limit".
 */
function inspect(raw: unknown, workspace?: unknown): Inspected {
  const problems: Problem[] = []
  const out: Inspected = { problems, quiet: null, window: null, launch: null, activeUntil: null, fallbackTimezone: null }
  if (raw != null && !isObject(raw)) {
    problems.push({ field: 'send_controls', message: 'send_controls must be an object' })
    return out
  }
  const c = raw ?? {}
  if (c.quiet_hours != null) out.quiet = checkSpan(c.quiet_hours, 'quiet_hours', 'quiet_hours', problems)
  else if (isObject(workspace) && !(isBlank(workspace.start) && isBlank(workspace.end))) {
    out.quiet = checkSpan(workspace, 'workspace_quiet_hours', 'workspace quiet hours', problems)
  }
  if (c.send_window != null) out.window = checkWindow(c.send_window, problems)
  if (c.launch_at != null) out.launch = checkInstant(c.launch_at, 'launch_at', problems)
  if (c.active_until != null) out.activeUntil = checkInstant(c.active_until, 'active_until', problems)
  if (c.fallback_timezone != null) {
    out.fallbackTimezone = c.fallback_timezone
    if (typeof c.fallback_timezone !== 'string' || (c.fallback_timezone.trim() && !validTz(c.fallback_timezone.trim()))) {
      problems.push({ field: 'fallback_timezone', message: 'fallback_timezone must be an IANA zone name such as "America/New_York"' })
    }
  }
  return out
}

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === 'string' && !v.trim())
}

/**
 * Save-time check of settings.send_controls. Returns one message per problem
 * (empty when it is absent or sound). Used by journey_upsert so bad config is
 * rejected with a clear error instead of reaching the send gate.
 */
export function validateSendControls(raw: unknown): string[] {
  return inspect(raw).problems.map((p) => p.message)
}

/** The same check for a journey's whole settings object. */
export function validateSettingsSendControls(settings: unknown): string[] {
  if (!isObject(settings)) return []
  return validateSendControls(settings.send_controls)
}

interface LocalParts {
  y: number
  m: number
  d: number
  dow: number
  minutes: number
}

function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatterFor(tz).formatToParts(date).map((p) => [p.type, p.value]))
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    dow: DOW[parts.weekday] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/** UTC offset of `tz` at `date`, to the minute (seconds are ignored, as the zone data is minute-granular). */
function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60)
  return asUtc - Math.floor(date.getTime() / MINUTE) * MINUTE
}

/**
 * The instant a lead-local wall-clock time happens. Ambiguous times (autumn, the clock repeats) take
 * the first occurrence. Nonexistent times (spring-forward gap) take the first valid instant after
 * the gap, i.e. the moment the clock jumps, so the result is never earlier than the wall-clock asked for.
 */
function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
  const offsets = [...new Set([
    offsetMs(new Date(guess - 24 * 60 * MINUTE), tz),
    offsetMs(new Date(guess), tz),
    offsetMs(new Date(guess + 24 * 60 * MINUTE), tz),
  ])]
  const valid = offsets
    .map((o) => guess - o)
    .filter((t) => offsetMs(new Date(t), tz) === guess - t)
  if (valid.length) return new Date(Math.min(...valid))
  // A gap. Offsets before and after the jump bracket it; find the first minute on the after side.
  const times = offsets.map((o) => guess - o).sort((a, b) => a - b)
  let lo = Math.floor(times[0] / MINUTE)
  let hi = Math.floor(times[times.length - 1] / MINUTE)
  const before = offsetMs(new Date(lo * MINUTE), tz)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (offsetMs(new Date(mid * MINUTE), tz) === before) lo = mid
    else hi = mid
  }
  return new Date(hi * MINUTE)
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function afterBoundary(date: Date): Date {
  return new Date(date.getTime() + MINUTE)
}

/** The later of two instants, but always strictly after `floor`, so a hold can never fail to advance. */
function laterOf(a: Date, b: Date, floor: Date): Date {
  const t = Math.max(a.getTime(), b.getTime(), floor.getTime() + MINUTE)
  return new Date(t)
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

/**
 * Pull settings.send_controls as stored, uninterpreted: undefined when absent. It may be malformed;
 * sendAllowed and validateSendControls check every field. Nothing is coerced here.
 */
export function readSendControls(settings: unknown): unknown {
  return isObject(settings) ? settings.send_controls : undefined
}

/**
 * May a send go out at `now`? When it may not, `until` is the first instant at which every control
 * allows it (one minute past the last boundary, so the next look is strictly after it, and always
 * after `now`). Past active-until is a skip, not a wait. Malformed controls hold the send for an
 * hour ('invalid send window' / 'invalid send controls'): fail closed, never "no limit".
 * Never throws.
 */
export function sendAllowed(now: Date, input: SendAllowedInput): SendDecision {
  const checked = inspect(input.controls, input.workspaceQuietHours)
  const tzInfo = resolveLeadTimezoneDetail({
    contactTimezone: input.contactTimezone,
    companyTimezone: input.companyTimezone,
    fallbackTimezone: typeof checked.fallbackTimezone === 'string' ? checked.fallbackTimezone : null,
  })
  const tz = tzInfo.timezone
  const flag: Flags = tzInfo.defaulted ? { timezone_defaulted: true } : {}
  const { quiet, window, launch, activeUntil } = checked
  const nowMs = now.getTime()

  if (activeUntil && nowMs >= activeUntil.getTime()) {
    return { allow: false, until: null, reason: 'past active-until', ...flag }
  }
  // fallback_timezone problems are not holds: an unknown zone falls back to the default, flagged.
  const blocking = checked.problems.filter((p) => p.field !== 'fallback_timezone')
  if (blocking.length) {
    return {
      allow: false,
      until: new Date(nowMs + INVALID_RETRY_MS),
      reason: blocking.some((p) => p.field === 'send_window') ? 'invalid send window' : 'invalid send controls',
      errors: blocking.map((p) => p.message),
      ...flag,
    }
  }

  // Walk forward to the first instant where every control allows. Each step moves to the end of
  // the holds in force, so one hold ending while another still applies never releases early.
  let at = now
  let reason: HoldReason | null = null
  if (launch && nowMs < launch.getTime()) {
    at = afterBoundary(launch)
    reason = 'before launch'
  }
  for (let step = 0; step < MAX_HOLD_STEPS; step++) {
    if (activeUntil && at.getTime() >= activeUntil.getTime()) {
      return { allow: false, until: null, reason: 'past active-until', ...flag }
    }
    let next = at
    let nextReason: HoldReason | null = null
    if (quiet && inSpan(localParts(at, tz).minutes, quiet.start, quiet.end)) {
      next = laterOf(next, quietEnd(at, tz, quiet.start, quiet.end), at)
      nextReason = 'quiet hours'
    }
    if (window && !inSendWindow(at, tz, window.days, window.start, window.end)) {
      const open = nextWindowOpen(at, tz, window.days, window.start)
      if (open.getTime() >= next.getTime()) nextReason = 'send window'
      next = laterOf(next, open, at)
    }
    if (!nextReason) break
    at = next
    reason = nextReason
  }
  if (!reason) return { allow: true, ...flag }
  // Guarantee a wait that moves forward even if a zone quirk resolved a boundary to <= now.
  const until = at.getTime() > nowMs ? at : afterBoundary(now)
  return { allow: false, until, reason, ...flag }
}
