/**
 * Routine background noise in lp.events: a scheduled job that finished normally. The runner
 * writes one 'job.finished' row per run, and journey_tick runs every minute, so on Oct 13 2026
 * the newest 200 events (three hours) were all "journey_tick finished: ok" / "trigger_scan
 * finished: ok" and the Overview "Recent" list and the Activity feed showed nothing else.
 *
 * Routine = a job run that ended ok or skipped. A failed or timed-out run is NOT routine and
 * still shows everywhere. The rows stay in lp.events (the Jobs page and the ops API read them);
 * human-facing feeds just leave them out unless someone asks for job events by name.
 * Alias `e` for lp.events.
 */
export const ROUTINE_EVENT_SQL = `(e.kind = 'job.finished' and coalesce(e.data->>'status', '') in ('ok', 'skipped'))`

/** The same rule for an event already in memory (client-side lists, tests). */
export function isRoutineEvent(ev: { kind: string; data?: unknown }): boolean {
  if (ev.kind !== 'job.finished') return false
  const status = ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>).status : undefined
  return status === 'ok' || status === 'skipped'
}
