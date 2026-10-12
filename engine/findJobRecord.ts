/**
 * Writes for lp.find_jobs (migration 0054): the durable per-run record for
 * find-leads jobs. find_leads tasks live in lp.tasks (scheduling/claiming);
 * this table is the domain record — pool FK, campaign, resolved params, which
 * config source the run used, lifecycle status and counters — so the Find
 * leads history does not depend on task-table internals.
 *
 * Relative imports only, no @/ aliases: the dashboard (lib/engine/jobs.ts)
 * and the plain-Node engine CLI (engine/cli.ts, engine/worker.ts) both use
 * this module.
 */
export interface FindJobQueryable {
  // rowCount is optional: the dashboard Db types it as number, PGlite's as
  // number | null | undefined. This module never reads it.
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>
}

export type FindJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface RecordFindJobInput {
  task_id: number
  campaign_id: number | null
  pool: string
  title: string
  params: Record<string, unknown>
  config_source: string | null
  created_by: string | null
}

/**
 * Insert the find_jobs row for a newly created find_leads task. Idempotent on
 * task_id (the CLI and the dashboard both record, and retries re-record).
 * Throws when lp.find_jobs is missing: the dashboard path must run migration
 * 0053 (it applies on deploy); a missing table there is a real problem.
 */
export async function recordFindJob(q: FindJobQueryable, input: RecordFindJobInput): Promise<void> {
  await q.query(
    `insert into lp.find_jobs (task_id, campaign_id, pool, title, status, params, config_source, created_by)
     values ($1, $2, $3, $4, 'pending', $5::jsonb, $6, $7)
     on conflict (task_id) do update set
       title = excluded.title, params = excluded.params, config_source = excluded.config_source`,
    [
      input.task_id,
      input.campaign_id,
      input.pool,
      input.title,
      JSON.stringify(input.params),
      input.config_source,
      input.created_by,
    ],
  )
}

export interface MarkFindJobPatch {
  status: FindJobStatus
  counters?: Record<string, unknown>
  error?: string | null
  report?: string | null
}

/**
 * Mark a find-leads run's lifecycle state. A missing lp.find_jobs table
 * (pre-0053 database) is NOT fatal here: the runner must not kill a run over
 * a registry row — the task row in lp.tasks is still the record of the job.
 */
export async function markFindJob(q: FindJobQueryable, taskId: number, patch: MarkFindJobPatch): Promise<void> {
  const sets = ['status = $2']
  const vals: unknown[] = [taskId, patch.status]
  if (patch.status === 'running') sets.push('started_at = coalesce(started_at, now())')
  if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') sets.push('finished_at = now()')
  if (patch.counters !== undefined) {
    vals.push(JSON.stringify(patch.counters))
    sets.push(`counters = $${vals.length}::jsonb`)
  }
  if (patch.error !== undefined) {
    vals.push(patch.error)
    sets.push(`error = $${vals.length}`)
  }
  if (patch.report !== undefined) {
    vals.push(patch.report)
    sets.push(`report = $${vals.length}`)
  }
  try {
    await q.query(`update lp.find_jobs set ${sets.join(', ')} where task_id = $1`, vals)
  } catch (e) {
    // Postgres 42P01 = undefined_table (pre-0053 database).
    if ((e as { code?: string } | null)?.code === '42P01') return
    throw e
  }
}

/** The find_jobs row for a task, when the table exists. */
export async function getFindJobRecord<T = Record<string, unknown>>(q: FindJobQueryable, taskId: number): Promise<T | null> {
  try {
    const { rows } = await q.query<T>('select * from lp.find_jobs where task_id = $1', [taskId])
    return rows[0] ?? null
  } catch (e) {
    if ((e as { code?: string } | null)?.code === '42P01') return null
    throw e
  }
}
