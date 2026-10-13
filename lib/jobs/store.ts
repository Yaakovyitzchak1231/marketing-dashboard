/**
 * The background job runner's server-side store: lp.jobs + lp.job_runs
 * (migration 0016). The runner on Yaakov's OVH box never touches this module
 * directly -- it calls claim_jobs / finish_job_run over the ops API, and THIS
 * file is what those ops call (lib/jobs/ops.ts). The DB is the single source
 * of truth; the SQL claim (FOR UPDATE SKIP LOCKED) lives here, server side.
 */
import type { Db, Queryable } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { nextRun, CronError } from './cron.ts'

export type JobStatus = 'running' | 'ok' | 'failed' | 'skipped' | 'timeout'

export interface JobRow {
  name: string
  kind: string
  description: string | null
  schedule_cron: string | null
  timezone: string
  campaign_id: number | null
  payload: Record<string, unknown>
  enabled: boolean
  timeout_s: number
  next_run_at: string | null
  last_run_at: string | null
  last_status: JobStatus | null
  last_error: string | null
  locked_by: string | null
  locked_until: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface JobRunRow {
  id: number
  job_name: string
  campaign_id: number | null
  runner: string | null
  actor: string | null
  status: JobStatus
  started_at: string
  finished_at: string | null
  output: Record<string, unknown> | null
  error: string | null
}

const NAME_RE = /^[a-z][a-z0-9_.:-]{0,79}$/
const KIND_RE = /^[a-z][a-z0-9_]{0,60}$/

function requireName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!NAME_RE.test(s)) throw new OpsError(`name must match ${NAME_RE} (got "${v}")`)
  return s
}
function requireKind(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!KIND_RE.test(s)) throw new OpsError(`kind must match ${KIND_RE} (got "${v}")`)
  return s
}
function jsonObject(v: unknown, field: string): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new OpsError(`${field} must be a JSON object`)
  return v as Record<string, unknown>
}
function campaignIdOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError('campaign_id must be a positive integer')
  return n
}

/** Validate the cron expression / timezone up front, with a clear error, before anything is stored. */
function validateSchedule(scheduleCron: string | null, timezone: string): void {
  if (scheduleCron == null) return
  try {
    nextRun(scheduleCron, new Date(), timezone)
  } catch (e) {
    if (e instanceof CronError) throw new OpsError(`bad schedule: ${e.message}`)
    throw e
  }
}

export interface UpsertJobInput {
  name: string
  kind: string
  description?: string | null
  schedule_cron?: string | null
  timezone?: string
  campaign_id?: number | null
  payload?: Record<string, unknown>
  enabled?: boolean
  timeout_s?: number
  via?: 'ui' | 'ops_api'
}

async function writeJobAudit(db: Queryable, actor: string, name: string, note: string, via: 'ui' | 'ops_api' | 'runner' = 'ops_api') {
  await db.query(
    `insert into lp.status_history (entity_type, entity_key, field, new_value, changed_by, via, note)
       values ('job', $1, 'definition', null, $2, $3, $4)`,
    [name, actor, via, note.slice(0, 1000)],
  )
}

/** Create or fully replace a job's definition (not its run-state). Owner or 'system' only (checked by the caller / ops layer). */
export async function upsertJob(db: Queryable, actor: string, input: UpsertJobInput): Promise<JobRow> {
  const name = requireName(input.name)
  const kind = requireKind(input.kind)
  const timezone = input.timezone?.trim() || 'America/New_York'
  const scheduleCron = input.schedule_cron?.trim() || null
  validateSchedule(scheduleCron, timezone)
  const campaignId = campaignIdOrNull(input.campaign_id)
  const payload = jsonObject(input.payload, 'payload')
  const enabled = input.enabled !== false
  const timeoutS = input.timeout_s == null ? 600 : Number(input.timeout_s)
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 86400) throw new OpsError('timeout_s must be between 1 and 86400')
  const nextRunAt = scheduleCron && enabled ? nextRun(scheduleCron, new Date(), timezone) : null

  const { rows } = await db.query<JobRow>(
    `insert into lp.jobs (name, kind, description, schedule_cron, timezone, campaign_id, payload, enabled, timeout_s, next_run_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (name) do update set
       kind = excluded.kind, description = excluded.description, schedule_cron = excluded.schedule_cron,
       timezone = excluded.timezone, campaign_id = excluded.campaign_id, payload = excluded.payload,
       enabled = excluded.enabled, timeout_s = excluded.timeout_s,
       next_run_at = case when lp.jobs.enabled = excluded.enabled and lp.jobs.schedule_cron is not distinct from excluded.schedule_cron
                          and lp.jobs.timezone = excluded.timezone then lp.jobs.next_run_at else excluded.next_run_at end
     returning *`,
    [name, kind, input.description ?? null, scheduleCron, timezone, campaignId, JSON.stringify(payload), enabled, timeoutS, nextRunAt, actor],
  )
  await writeJobAudit(db, actor, name, `${kind} job saved (schedule ${scheduleCron ?? 'on demand only'}, ${enabled ? 'enabled' : 'disabled'})`, input.via ?? 'ops_api')
  return rows[0]
}

export async function listJobs(db: Queryable, filter: { campaign_id?: number; kind?: string; enabled?: boolean } = {}): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `select * from lp.jobs
      where ($1::bigint is null or campaign_id = $1)
        and ($2::text is null or kind = $2)
        and ($3::boolean is null or enabled = $3)
      order by name`,
    [filter.campaign_id ?? null, filter.kind ?? null, filter.enabled ?? null],
  )
  return rows
}

export async function getJob(db: Queryable, name: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>('select * from lp.jobs where name = $1', [requireName(name)])
  return rows[0] ?? null
}

/** Enable/disable a job; recomputes next_run_at from its cron when (re)enabling. */
export async function setEnabled(db: Queryable, actor: string, name: string, enabled: boolean, via: 'ui' | 'ops_api' = 'ops_api'): Promise<JobRow> {
  const job = await getJob(db, name)
  if (!job) throw new OpsError(`job "${name}" not found`, 404)
  if (job.enabled === enabled) return job
  const nextRunAt = enabled && job.schedule_cron ? nextRun(job.schedule_cron, new Date(), job.timezone) : job.next_run_at
  const { rows } = await db.query<JobRow>(
    `update lp.jobs set enabled = $1, next_run_at = $2 where name = $3 returning *`,
    [enabled, enabled ? nextRunAt : job.next_run_at, name],
  )
  await writeJobAudit(db, actor, name, enabled ? 'enabled' : 'disabled', via)
  return rows[0]
}

/** Queue an immediate run by moving next_run_at to now. The runner picks it up on its next poll. */
export async function runNow(db: Queryable, actor: string, name: string): Promise<JobRow> {
  const job = await getJob(db, name)
  if (!job) throw new OpsError(`job "${name}" not found`, 404)
  const { rows } = await db.query<JobRow>(`update lp.jobs set next_run_at = now() where name = $1 returning *`, [name])
  void actor
  return rows[0]
}

export interface ClaimedJob {
  job: JobRow
  run_id: number
}

/**
 * Claim every due, enabled job whose lock is free, in one statement: FOR
 * UPDATE SKIP LOCKED means two runners calling this at once never get the
 * same row (the second simply skips rows the first is holding). Sets
 * locked_by / locked_until and inserts a 'running' lp.job_runs row for each,
 * all inside one transaction so a claim and its run row are never split.
 */
export async function claimDueJobs(db: Db, runnerId: string, limit = 5): Promise<ClaimedJob[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new OpsError('limit must be between 1 and 50')
  return db.tx(async (q) => {
    const { rows: due } = await q.query<JobRow>(
      `select * from lp.jobs
         where enabled and next_run_at is not null and next_run_at <= now()
           and (locked_until is null or locked_until < now())
         order by next_run_at
         limit $1
         for update skip locked`,
      [limit],
    )
    const claimed: ClaimedJob[] = []
    for (const job of due) {
      const { rows: locked } = await q.query<JobRow>(
        `update lp.jobs set locked_by = $1, locked_until = now() + ($2 || ' seconds')::interval, last_status = 'running'
           where name = $3
           returning *`,
        [runnerId, job.timeout_s, job.name],
      )
      const { rows: run } = await q.query<{ id: number }>(
        `insert into lp.job_runs (job_name, campaign_id, runner, actor, status)
           values ($1, $2, $3, 'system', 'running') returning id`,
        [job.name, job.campaign_id, runnerId],
      )
      claimed.push({ job: locked[0], run_id: run[0].id })
    }
    return claimed
  }, 'system')
}

export interface FinishRunInput {
  status: Exclude<JobStatus, 'running'>
  output?: Record<string, unknown> | null
  error?: string | null
}

/**
 * Record how a claimed run ended: closes the lp.job_runs row, updates the
 * job's last_* fields, clears its lock, and (on a cron job) computes the next
 * next_run_at from cron.ts -- from now, not from the missed slot, so a late
 * or failed run never causes a burst of catch-up runs. Writes one lp.events
 * 'job.finished' row.
 */
export async function finishRun(db: Db, actor: string, runId: number, input: FinishRunInput): Promise<JobRunRow> {
  if (!Number.isInteger(runId) || runId <= 0) throw new OpsError('run_id must be a positive integer')
  const status = input.status
  if (!['ok', 'failed', 'skipped', 'timeout'].includes(status)) throw new OpsError(`status must be ok|failed|skipped|timeout, got "${status}"`)
  const output = input.output === undefined || input.output === null ? null : jsonObject(input.output, 'output')
  const error = input.error ?? null

  return db.tx(async (q) => {
    const { rows: runRows } = await q.query<JobRunRow & { job_name: string }>(
      `update lp.job_runs set status = $1, finished_at = now(), output = $2, error = $3
         where id = $4 and status = 'running'
         returning *`,
      [status, output ? JSON.stringify(output) : null, error, runId],
    )
    const run = runRows[0]
    if (!run) throw new OpsError(`run ${runId} not found or already finished`, 409)

    const job = await getJob(q, run.job_name)
    if (!job) throw new OpsError(`job "${run.job_name}" not found`, 404)

    // A failed run still reschedules on its cron (so one bad run doesn't stop the job forever);
    // only a disabled or on-demand-only job gets no new next_run_at.
    const rescheduled = job.enabled && job.schedule_cron ? nextRun(job.schedule_cron, new Date(), job.timezone) : null

    await q.query(
      `update lp.jobs set last_run_at = now(), last_status = $1, last_error = $2, locked_by = null, locked_until = null, next_run_at = $3
         where name = $4`,
      [status, error, rescheduled, job.name],
    )

    await q.query(
      `insert into lp.events (actor, kind, summary, entity_type, entity_id, data) values ($1, 'job.finished', $2, 'job', $3, $4)`,
      [actor, `${job.name} finished: ${status}${error ? ` (${error.slice(0, 200)})` : ''}`, job.name, JSON.stringify({ run_id: runId, status, output })],
    )

    return { ...run, status, output, error }
  }, actor)
}

/** Mark any run whose lock has expired (the runner died / crashed) as 'timeout', freeing the job for the next poll. */
export async function reapStale(db: Db, actor = 'system'): Promise<string[]> {
  return db.tx(async (q) => {
    const { rows: stale } = await q.query<{ name: string }>(
      `select name from lp.jobs where locked_until is not null and locked_until < now()`,
    )
    const names: string[] = []
    for (const { name } of stale) {
      const { rows: runRows } = await q.query<{ id: number }>(
        `select id from lp.job_runs where job_name = $1 and status = 'running' order by started_at desc limit 1`,
        [name],
      )
      if (runRows[0]) {
        await q.query(`update lp.job_runs set status = 'timeout', finished_at = now(), error = 'runner lock expired' where id = $1`, [runRows[0].id])
        await q.query(`insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'job.finished', $2, 'job', $3)`, [
          actor,
          `${name} finished: timeout (lock expired)`,
          name,
        ])
      }
      await q.query(`update lp.jobs set locked_by = null, locked_until = null, last_status = 'timeout', last_error = 'runner lock expired' where name = $1`, [name])
      names.push(name)
    }
    return names
  }, actor)
}

/**
 * The newest run of every job, however long ago it was. The Jobs page used to group the last
 * 40 runs of ALL jobs, so one chatty job (journey_tick runs every minute) pushed every other
 * job out of the window and a job that ran last night read "never run".
 */
export async function latestRunPerJob(db: Queryable): Promise<JobRunRow[]> {
  const { rows } = await db.query<JobRunRow>(
    `select distinct on (job_name) * from lp.job_runs order by job_name, started_at desc, id desc`,
  )
  return rows
}

/** Failed or timed-out runs, newest first, read on their own so routine successes can't hide them. */
export async function recentFailedRuns(db: Queryable, limit = 20): Promise<JobRunRow[]> {
  const { rows } = await db.query<JobRunRow>(
    `select * from lp.job_runs where status in ('failed', 'timeout') order by started_at desc limit $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 200)],
  )
  return rows
}

export async function listJobRuns(db: Queryable, filter: { job_name?: string; limit?: number } = {}): Promise<JobRunRow[]> {
  const limit = Math.min(Math.max(Number(filter.limit) || 25, 1), 200)
  const { rows } = await db.query<JobRunRow>(
    `select * from lp.job_runs where ($1::text is null or job_name = $1) order by started_at desc limit $2`,
    [filter.job_name ?? null, limit],
  )
  return rows
}
