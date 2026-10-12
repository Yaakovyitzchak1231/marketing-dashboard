/**
 * Per-lead send-time optimisation — plan 3.11 (scheduling half).
 *
 * resolveSendTime is the seam the journey scheduler (plan 3.1) calls when
 * dispatching a timed step: given the time the step is due, shift it into
 * the lead's optimal window. No window (or no engagement history) means the
 * due time passes through unchanged.
 */
import type { Db } from '../db/types.ts'
import { getSendWindow, leadKey, recomputeSendWindow, type SendWindow } from './analyze.ts'

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
 * The next instant at/after `from` that lands in the lead's window, as a
 * Date. Pure (no database), so the scheduler and tests share it.
 */
export function optimalSendAt(window: SendWindow, from: Date): Date {
  const off0 = offsetMinutes(window.timezone, from)
  const wallFrom = from.getTime() + off0 * 60000
  const wf = new Date(wallFrom)
  // Today at best_hour (wall clock), else tomorrow.
  let cand = Date.UTC(wf.getUTCFullYear(), wf.getUTCMonth(), wf.getUTCDate(), window.best_hour, 0, 0)
  if (cand <= wallFrom) cand += 86400000
  // Prefer the best day of week, but never push more than a week out.
  if (window.best_dow != null) {
    for (let i = 0; i < 7 && new Date(cand).getUTCDay() !== window.best_dow; i++) cand += 86400000
  }
  // Back to absolute time (re-derive the offset at the candidate for DST edges).
  const abs = cand - offsetMinutes(window.timezone, new Date(cand - off0 * 60000)) * 60000
  const out = new Date(abs)
  return out.getTime() < from.getTime() ? from : out
}

export interface ResolveOpts {
  /** Recompute the window from engagement history when none is stored. */
  computeIfMissing?: boolean
}

/**
 * Scheduler entry point: the send time for a lead, shifted into its optimal
 * window when one is known. Passes `desiredAt` through unchanged otherwise.
 */
export async function resolveSendTime(
  db: Db,
  companyId: number | null,
  contactId: number | null,
  desiredAt: Date,
  opts: ResolveOpts = {},
): Promise<{ send_at: Date; shifted: boolean; window: SendWindow | null }> {
  const key = leadKey(companyId, contactId)
  let window = await getSendWindow(db, key)
  if (!window && opts.computeIfMissing) window = await recomputeSendWindow(db, key)
  if (!window) return { send_at: desiredAt, shifted: false, window: null }
  const sendAt = optimalSendAt(window, desiredAt)
  return { send_at: sendAt, shifted: sendAt.getTime() !== desiredAt.getTime(), window }
}
