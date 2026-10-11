/**
 * A small, dependency-free 5-field cron parser (minute hour day-of-month month
 * day-of-week): '*', lists ("1,2,3"), ranges ("1-5"), steps (e.g. every 15
 * units, or 10-20 stepped by 5), and names (MON..SUN, JAN..DEC) are accepted.
 * No external cron library -- just Intl, which already ships with Node.
 *
 * nextRun(expr, from, timezone) returns the next UTC instant, strictly after
 * `from`, that matches the expression's wall-clock fields AS LIVED in the
 * given IANA timezone (so "0 9 * * 1-5" means "9am local, Mon-Fri", correct
 * across a DST transition: a spring-forward gap is never matched because we
 * only trust instants we can format back to the same local fields, and a
 * fall-back is matched once, not twice, because the offset search below is
 * deterministic).
 *
 * The day-of-month / day-of-week OR rule (standard cron, not Quartz): when
 * BOTH fields are restricted (neither is '*'), a day matches if it satisfies
 * EITHER one. When only one is restricted, that one alone decides.
 */

export class CronError extends Error {}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  min: number
  max: number
  names?: string[]
}

function resolveToken(tok: string, spec: FieldSpec, fieldName: string, exprForError: string): number {
  const t = tok.trim().toLowerCase()
  if (spec.names) {
    const idx = spec.names.indexOf(t)
    if (idx >= 0) return idx + spec.min
  }
  if (!/^-?\d+$/.test(t)) throw new CronError(`${fieldName}: "${tok}" is not a number or known name (in "${exprForError}")`)
  const n = Number(t)
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${fieldName}: ${n} is out of range [${spec.min}, ${spec.max}] (in "${exprForError}")`)
  }
  return n
}

function parseField(raw: string, spec: FieldSpec, fieldName: string, exprForError: string): Set<number> {
  const out = new Set<number>()
  const alternatives = raw.split(',')
  for (const rawAlt of alternatives) {
    const alt = rawAlt.trim()
    if (!alt) throw new CronError(`${fieldName}: empty value in "${raw}" (in "${exprForError}")`)
    let step = 1
    let rangePart = alt
    const stepSplit = alt.indexOf('/')
    if (stepSplit >= 0) {
      rangePart = alt.slice(0, stepSplit)
      const stepRaw = alt.slice(stepSplit + 1)
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) <= 0) {
        throw new CronError(`${fieldName}: bad step "${stepRaw}" in "${alt}" (in "${exprForError}")`)
      }
      step = Number(stepRaw)
    }
    let start: number
    let end: number
    if (rangePart === '*') {
      start = spec.min
      end = spec.max
    } else if (rangePart.includes('-')) {
      const dashAt = rangePart.indexOf('-')
      const fromTok = rangePart.slice(0, dashAt)
      const toTok = rangePart.slice(dashAt + 1)
      if (!fromTok || !toTok) throw new CronError(`${fieldName}: bad range "${rangePart}" (in "${exprForError}")`)
      start = resolveToken(fromTok, spec, fieldName, exprForError)
      end = resolveToken(toTok, spec, fieldName, exprForError)
      if (start > end) throw new CronError(`${fieldName}: range "${rangePart}" has start > end (in "${exprForError}")`)
    } else {
      start = end = resolveToken(rangePart, spec, fieldName, exprForError)
    }
    for (let v = start; v <= end; v += step) out.add(v)
  }
  if (out.size === 0) throw new CronError(`${fieldName}: no values parsed from "${raw}" (in "${exprForError}")`)
  return out
}

export interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

/** Parse a 5-field cron expression. Throws CronError with a clear message for anything malformed. */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== 'string' || !expr.trim()) throw new CronError('cron expression is empty')
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expr}"`)
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields
  const minute = parseField(minuteRaw, { min: 0, max: 59 }, 'minute', expr)
  const hour = parseField(hourRaw, { min: 0, max: 23 }, 'hour', expr)
  const domRestricted = domRaw.trim() !== '*'
  const dom = parseField(domRaw, { min: 1, max: 31 }, 'day-of-month', expr)
  const month = parseField(monthRaw, { min: 1, max: 12, names: MONTH_NAMES }, 'month', expr)
  const dowRestricted = dowRaw.trim() !== '*'
  const dowRaw0to7 = parseField(dowRaw, { min: 0, max: 7, names: DOW_NAMES }, 'day-of-week', expr)
  const dow = new Set([...dowRaw0to7].map((v) => (v === 7 ? 0 : v))) // 7 = Sunday too, same as 0
  return { minute, hour, dom, month, dow, domRestricted, dowRestricted }
}

// --------------------------------------------------------------- timezone math

interface LocalParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
  weekday: number // 0=Sun .. 6=Sat
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    dtfCache.set(tz, f)
  }
  return f
}

/** Validate an IANA zone name early with a clear error, instead of Intl's generic RangeError later. */
export function assertValidTimezone(tz: string): void {
  try {
    formatter(tz)
  } catch {
    throw new CronError(`unknown IANA timezone "${tz}"`)
  }
}

function localPartsFromUtc(utcMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(utcMs))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const hourStr = get('hour')
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hourStr === '24' ? 0 : Number(hourStr), // defend against an ICU edge case at local midnight
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

/** The tz offset, in minutes (local = utc + offset), effective AT this UTC instant. */
function offsetMinutesAt(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const hourVal = get('hour') === 24 ? 0 : get('hour')
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hourVal, get('minute'), get('second'))
  return Math.round((asUtc - utcMs) / 60000)
}

/**
 * The UTC instant for wall-clock (y, mo, d, h, mi, 0) AS LIVED in `tz`.
 * `existed` is false when that local time falls in a spring-forward gap (it
 * never happened); the returned instant is then the nearest real one, which
 * the caller re-validates on its next loop pass rather than trusting blindly.
 */
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): { utcMs: number; existed: boolean } {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  for (let i = 0; i < 4; i++) {
    const offset = offsetMinutesAt(guess, tz)
    const next = Date.UTC(y, mo - 1, d, h, mi, 0) - offset * 60000
    if (next === guess) break
    guess = next
  }
  const check = localPartsFromUtc(guess, tz)
  const existed = check.year === y && check.month === mo && check.day === d && check.hour === h && check.minute === mi
  return { utcMs: guess, existed }
}

function addCalendarDays(y: number, mo: number, d: number, days: number): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

function smallestAbove(set: Set<number>, current: number): number | null {
  let best: number | null = null
  for (const v of set) {
    if (v > current && (best === null || v < best)) best = v
  }
  return best
}
function smallest(set: Set<number>): number {
  let best = Infinity
  for (const v of set) if (v < best) best = v
  return best
}

const MAX_DAY_STEPS = 366 * 5 + 10 // 5-year safety bound; a real schedule always matches well inside this

/**
 * The next UTC instant, strictly after `from`, that the cron expression
 * matches in `timezone` (IANA name; defaults to America/New_York, the
 * runner's default). Throws CronError for a bad expression, bad timezone, or
 * (pathologically) no match within 5 years.
 */
export function nextRun(expr: string, from: Date | number = new Date(), timezone = 'America/New_York'): Date {
  const cron = parseCron(expr)
  assertValidTimezone(timezone)
  const fromMs = typeof from === 'number' ? from : from.getTime()
  let candidateUtc = Math.floor(fromMs / 60000) * 60000 + 60000 // next whole minute, strictly after `from`
  let steps = 0

  // Every reassignment of candidateUtc goes through here: a nonexistent local
  // time (a spring-forward gap) can otherwise resolve to an instant at or
  // before the current one, which would loop forever retrying the same gap.
  // Forcing strictly-increasing progress is what makes a gap "never matched"
  // instead of "hangs".
  const advanceTo = (wantUtc: number) => {
    candidateUtc = wantUtc > candidateUtc ? wantUtc : candidateUtc + 60000
  }
  const startOfDay = (y: number, mo: number, d: number) => zonedTimeToUtc(y, mo, d, 0, 0, timezone).utcMs

  for (;;) {
    if (steps++ > MAX_DAY_STEPS * 1440) throw new CronError(`no run of "${expr}" found within 5 years of ${new Date(fromMs).toISOString()}`)
    const lp = localPartsFromUtc(candidateUtc, timezone)

    const monthOk = cron.month.has(lp.month)
    const domOk = !cron.domRestricted || cron.dom.has(lp.day)
    const dowOk = !cron.dowRestricted || cron.dow.has(lp.weekday)
    const dateOk = monthOk && (cron.domRestricted && cron.dowRestricted ? domOk || dowOk : domOk && dowOk)

    if (!dateOk) {
      const nd = addCalendarDays(lp.year, lp.month, lp.day, 1)
      advanceTo(startOfDay(nd.year, nd.month, nd.day))
      continue
    }

    if (!cron.hour.has(lp.hour)) {
      const nextHour = smallestAbove(cron.hour, lp.hour)
      if (nextHour === null) {
        const nd = addCalendarDays(lp.year, lp.month, lp.day, 1)
        advanceTo(startOfDay(nd.year, nd.month, nd.day))
      } else {
        advanceTo(zonedTimeToUtc(lp.year, lp.month, lp.day, nextHour, smallest(cron.minute), timezone).utcMs)
      }
      continue
    }

    if (!cron.minute.has(lp.minute)) {
      const nextMinute = smallestAbove(cron.minute, lp.minute)
      if (nextMinute === null) {
        const nextHour = smallestAbove(cron.hour, lp.hour)
        if (nextHour === null) {
          const nd = addCalendarDays(lp.year, lp.month, lp.day, 1)
          advanceTo(startOfDay(nd.year, nd.month, nd.day))
        } else {
          advanceTo(zonedTimeToUtc(lp.year, lp.month, lp.day, nextHour, smallest(cron.minute), timezone).utcMs)
        }
      } else {
        advanceTo(zonedTimeToUtc(lp.year, lp.month, lp.day, lp.hour, nextMinute, timezone).utcMs)
      }
      continue
    }

    // Every field matches at this real, formattable instant.
    return new Date(candidateUtc)
  }
}
