/**
 * Is the background runner alive? The runner authenticates as actor `system` and
 * polls claim_jobs every ~15 s, so every poll marks the system actor as seen and
 * its key as used. The newest of those (and of its job runs) is its heartbeat.
 */
import type { Queryable } from '../db/types.ts'

/** A heartbeat newer than this counts as online (the runner polls every ~15 s). */
export const RUNNER_ONLINE_MS = 5 * 60_000

export interface RunnerSignals {
  /** lp.actors.last_seen_at for 'system'. */
  actorSeenAt: Date | string | null
  /** Newest last_used_at of a live (not revoked) key of 'system'. */
  keyUsedAt: Date | string | null
  /** Newest job run by a runner: its runner id and when it started or finished. */
  lastRun: { runner: string | null; at: Date | string | null } | null
}

export interface RunnerStatus {
  state: 'online' | 'offline' | 'never'
  /** ISO time of the newest heartbeat, null when none. */
  lastSeen: string | null
  /** Runner instance id from the newest job run (e.g. ovh-runner-1), if any. */
  runner: string | null
}

function ms(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const t = v instanceof Date ? v.getTime() : Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function runnerStatus(s: RunnerSignals, now: Date = new Date()): RunnerStatus {
  const times = [ms(s.actorSeenAt), ms(s.keyUsedAt), ms(s.lastRun?.at)].filter((t): t is number => t !== null)
  const runner = s.lastRun?.runner ?? null
  if (!times.length) return { state: 'never', lastSeen: null, runner }
  const last = Math.max(...times)
  const age = now.getTime() - last
  return { state: age <= RUNNER_ONLINE_MS ? 'online' : 'offline', lastSeen: new Date(last).toISOString(), runner }
}

/** "just now", "1m ago", "3h ago", "2d ago". */
export function agoWords(iso: string | null, now: Date = new Date()): string {
  const t = ms(iso)
  if (t === null) return 'never'
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.max(1, Math.round(secs / 60))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** One line for the Jobs page header. */
export function runnerLabel(st: RunnerStatus, now: Date = new Date()): string {
  if (st.state === 'never') return 'Runner never connected'
  const who = st.runner ? ` (${st.runner})` : ''
  const seen = agoWords(st.lastSeen, now)
  return st.state === 'online' ? `Runner online${who} · last seen ${seen}` : `Runner offline${who} · last seen ${seen}`
}

/** Reads the three heartbeat signals in one query. */
export async function loadRunnerSignals(q: Queryable): Promise<RunnerSignals> {
  const { rows } = await q.query<{ actor_seen: Date | null; key_used: Date | null; runner: string | null; run_at: Date | null }>(
    `select
       (select last_seen_at from lp.actors where id = 'system') as actor_seen,
       (select max(last_used_at) from lp.agent_keys where actor_id = 'system' and revoked_at is null) as key_used,
       r.runner, coalesce(r.finished_at, r.started_at) as run_at
     from (select 1) one
     left join lateral (
       select runner, started_at, finished_at from lp.job_runs
        where runner is not null order by started_at desc limit 1
     ) r on true`,
  )
  const r = rows[0]
  return {
    actorSeenAt: r?.actor_seen ?? null,
    keyUsedAt: r?.key_used ?? null,
    lastRun: r && (r.runner || r.run_at) ? { runner: r.runner, at: r.run_at } : null,
  }
}
