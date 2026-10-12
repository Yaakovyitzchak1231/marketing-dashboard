/**
 * Per-lead send-time optimisation — plan 3.11 (scheduling half).
 *
 * resolveSendTime is the function a scheduler calls with the time a step is
 * due; it shifts that time into the lead's optimal window. NOTHING IN
 * PRODUCTION CALLS IT YET: on main, sequence timing belongs to Instantly (the
 * dashboard only pushes delay_days), and the journey executor that would own a
 * "next send" does not exist on main. docs/SEND_TIME.md says exactly where it
 * plugs in once one does.
 *
 * No usable window (none stored, expired, or none for the campaign) means the
 * due time passes through unchanged. Guardrails:
 *  - sends never leave business hours (8:00-18:00 lead-local), whatever the
 *    learned hour;
 *  - the shift is at most MAX_SHIFT_HOURS; a preferred weekday further out
 *    than that is dropped, but the clamped best-hour time (never more than a
 *    day out) is still used, never the raw due time, which could be 3am;
 *  - nothing here throws on a bad timezone: the due time comes back.
 */
import type { Db } from '../db/types.ts'
import {
  getCampaignSendWindow,
  getSendWindow,
  isWindowExpired,
  leadKey,
  recomputeCampaignWindow,
  recomputeSendWindow,
  type CampaignSendWindow,
  type SendWindow,
  type WindowBase,
} from './analyze.ts'
import { BUSINESS_DAYS, MAX_SHIFT_HOURS, QUIET_HOURS_END, QUIET_HOURS_START } from './config.ts'
import { isValidTimezone } from './tz.ts'

export { MAX_SHIFT_HOURS, QUIET_HOURS_END, QUIET_HOURS_START }

const DAY_MS = 86400000

/** Minutes to add to a UTC instant to get wall time in tz (DST-aware). */
function offsetMinutes(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return Math.round((asUTC - date.getTime()) / 60000)
}

/**
 * The UTC instant whose wall clock in tz reads `wallMs` (given as a UTC-style
 * timestamp of the wall time). Re-derives the offset at the result so a wall
 * time next to a DST change lands on the right side of it. A wall time that
 * does not exist (the spring-forward gap) maps to a real instant just after.
 */
function wallToInstant(tz: string, wallMs: number): number {
  const o1 = offsetMinutes(tz, new Date(wallMs - offsetMinutes(tz, new Date(wallMs)) * 60000))
  let inst = wallMs - o1 * 60000
  const o2 = offsetMinutes(tz, new Date(inst))
  if (o2 !== o1) inst = wallMs - o2 * 60000
  return inst
}

export type WindowLike = Pick<WindowBase, 'best_hour' | 'best_dow' | 'timezone'>

/**
 * The next instant at/after `from` that lands in the lead's window, as a
 * Date. Pure (no database), so the scheduler and tests share it. Never
 * throws: an unusable timezone or hour returns `from` unchanged.
 */
export function optimalSendAt(window: WindowLike, from: Date): Date {
  try {
    return shiftIntoWindow(window, from)
  } catch {
    return from
  }
}

function shiftIntoWindow(window: WindowLike, from: Date): Date {
  const tz = window.timezone
  if (!isValidTimezone(tz) || !Number.isFinite(window.best_hour) || Number.isNaN(from.getTime())) return from
  // Quiet-hours clamp: never schedule outside 8:00-18:00 lead-local.
  const hour = Math.min(Math.max(Math.trunc(window.best_hour), QUIET_HOURS_START), QUIET_HOURS_END)
  const fromMs = from.getTime()
  const wf = new Date(fromMs + offsetMinutes(tz, from) * 60000)
  // Today at the (clamped) best hour, wall clock; tomorrow if that instant has passed.
  let cand = Date.UTC(wf.getUTCFullYear(), wf.getUTCMonth(), wf.getUTCDate(), hour, 0, 0)
  if (wallToInstant(tz, cand) <= fromMs) cand += DAY_MS
  // The fallback: always inside business hours and at most about a day out.
  const bestHourAt = wallToInstant(tz, cand)

  const dow = window.best_dow
  if (dow == null || !BUSINESS_DAYS.includes(dow)) return new Date(bestHourAt)
  // Prefer the best weekday, but never push further than MAX_SHIFT_HOURS.
  let dowCand = cand
  for (let i = 0; i < 7 && new Date(dowCand).getUTCDay() !== dow; i++) dowCand += DAY_MS
  const dowAt = wallToInstant(tz, dowCand)
  return new Date(dowAt - fromMs <= MAX_SHIFT_HOURS * 3600000 ? dowAt : bestHourAt)
}

export interface ResolveOpts {
  /** Recompute the window from engagement history when none is stored. */
  computeIfMissing?: boolean
  /** Fall back to this campaign's aggregate window when the lead has no usable window of its own. */
  campaignId?: number | null
  /** Evaluation time (expiry check); defaults to now. */
  now?: Date
}

export type WindowSource = 'lead' | 'campaign'

export interface ResolvedSendTime {
  send_at: Date
  shifted: boolean
  /** The window used, or null when the due time passed through. */
  window: SendWindow | CampaignSendWindow | null
  /** 'lead' = the lead's own window, 'campaign' = the campaign fallback, null = none. */
  source: WindowSource | null
}

/**
 * Scheduler entry point: the send time for a lead, shifted into its optimal
 * window when one is known. An expired window (newest evidence older than
 * WINDOW_MAX_AGE_DAYS) counts as absent. Passes `desiredAt` through unchanged
 * when no usable window exists.
 */
export async function resolveSendTime(
  db: Db,
  companyId: number | null,
  contactId: number | null,
  desiredAt: Date,
  opts: ResolveOpts = {},
): Promise<ResolvedSendTime> {
  const now = opts.now ?? new Date()
  const key = leadKey(companyId, contactId)
  const usable = <T extends WindowBase>(w: T | null): T | null => (w && !isWindowExpired(w, now) ? w : null)

  let lead = usable(await getSendWindow(db, key))
  if (!lead && opts.computeIfMissing) lead = usable(await recomputeSendWindow(db, key, { now }))
  if (lead) return build(lead, 'lead', desiredAt)

  if (opts.campaignId != null) {
    let camp = usable(await getCampaignSendWindow(db, opts.campaignId))
    if (!camp && opts.computeIfMissing) camp = usable(await recomputeCampaignWindow(db, opts.campaignId, { now }))
    if (camp) return build(camp, 'campaign', desiredAt)
  }
  return { send_at: desiredAt, shifted: false, window: null, source: null }
}

function build(window: SendWindow | CampaignSendWindow, source: WindowSource, desiredAt: Date): ResolvedSendTime {
  const sendAt = optimalSendAt(window, desiredAt)
  return { send_at: sendAt, shifted: sendAt.getTime() !== desiredAt.getTime(), window, source }
}
