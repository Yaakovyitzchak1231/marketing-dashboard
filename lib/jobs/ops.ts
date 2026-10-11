/**
 * Job-runner ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts). The runner on Yaakov's OVH box authenticates as actor
 * 'system' with its own key and talks to the dashboard only through these
 * four: claim_jobs, finish_job_run, job_runs (read), list_jobs (read). Humans
 * (and the dashboard UI, as 'owner') manage job definitions with put_job /
 * run_job_now / list_jobs.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { requireOwnerOrSystem as requireOwnerOrSystemShared } from '../ops/actor-role.ts'
import { claimDueJobs, finishRun, getJob, listJobRuns, listJobs, reapStale, runNow, setEnabled, upsertJob, type JobStatus } from './store.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

/** An Owner (the built-in 'owner' or any active human Owner, see isOwnerActor) or the runner ('system'). */
async function requireOwnerOrSystem(db: Db, actor: string): Promise<void> {
  await requireOwnerOrSystemShared(db, actor, 'only an owner or the system actor can manage job definitions')
}
function requireSystem(actor: string): void {
  if (actor !== 'system') throw new OpsError("only actor 'system' (the runner's own key) can do this", 403)
}
function requireName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) throw new OpsError('name is required')
  return s
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (v == null ? undefined : Number(v))

export const JOB_OPS: Record<string, Op> = {
  list_jobs: {
    args: '{campaign_id?, kind?, enabled?}',
    run: (db, _actor, a) =>
      listJobs(db, {
        campaign_id: a.campaign_id == null ? undefined : Number(a.campaign_id),
        kind: str(a.kind),
        enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
      }),
  },
  get_job: {
    args: '{name}',
    run: async (db, _actor, a) => {
      const j = await getJob(db, requireName(a.name))
      if (!j) throw new OpsError(`job "${a.name}" not found`, 404)
      return j
    },
  },
  put_job: {
    args: '{name, kind, description?, schedule_cron?, timezone?, campaign_id?, payload?, enabled?, timeout_s?}  -- owner or system only',
    run: async (db, actor, a) => {
      await requireOwnerOrSystem(db, actor)
      return upsertJob(db, actor, {
        name: requireName(a.name),
        kind: String(a.kind ?? ''),
        description: str(a.description) ?? null,
        schedule_cron: str(a.schedule_cron) ?? null,
        timezone: str(a.timezone),
        campaign_id: a.campaign_id as number | null | undefined,
        payload: a.payload as Record<string, unknown> | undefined,
        enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
        timeout_s: num(a.timeout_s),
      })
    },
  },
  set_job_enabled: {
    args: '{name, enabled}  -- owner or system only',
    run: async (db, actor, a) => {
      await requireOwnerOrSystem(db, actor)
      return setEnabled(db, actor, requireName(a.name), a.enabled !== false)
    },
  },
  run_job_now: {
    args: '{name}  -- queues an immediate run; the runner picks it up on its next poll',
    run: async (db, actor, a) => {
      await requireOwnerOrSystem(db, actor)
      return runNow(db, actor, requireName(a.name))
    },
  },
  claim_jobs: {
    args: "{runner, limit?}  -- only actor 'system'; FOR UPDATE SKIP LOCKED under the hood, safe to call from several runner processes",
    run: async (db, actor, a) => {
      requireSystem(actor)
      const runner = typeof a.runner === 'string' && a.runner.trim() ? a.runner.trim() : null
      if (!runner) throw new OpsError('runner is required (a stable id for this runner process, e.g. host:pid)')
      return claimDueJobs(db, runner, a.limit == null ? 5 : Number(a.limit))
    },
  },
  finish_job_run: {
    args: "{run_id, status: ok|failed|skipped|timeout, output?, error?}  -- only actor 'system'",
    run: async (db, actor, a) => {
      requireSystem(actor)
      const status = String(a.status ?? '') as JobStatus
      if (!['ok', 'failed', 'skipped', 'timeout'].includes(status)) throw new OpsError('status must be ok|failed|skipped|timeout')
      return finishRun(db, actor, Number(a.run_id), {
        status: status as Exclude<JobStatus, 'running'>,
        output: a.output as Record<string, unknown> | undefined,
        error: str(a.error) ?? null,
      })
    },
  },
  reap_stale_jobs: {
    args: "{}  -- marks runs whose lock expired as 'timeout'; owner or system only",
    run: async (db, actor) => {
      await requireOwnerOrSystem(db, actor)
      return reapStale(db, 'system')
    },
  },
  job_runs: {
    args: '{name?, limit?}',
    run: (db, _actor, a) => listJobRuns(db, { job_name: str(a.name), limit: num(a.limit) }),
  },
}
