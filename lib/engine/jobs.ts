/**
 * Server-side helpers behind the Find leads screen and its API routes:
 * create / list / cancel find_leads jobs, and queue research_company tasks.
 * The work itself runs in the engine worker (engine/worker.ts) on a server,
 * never inside a request.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { createTask, OpsError, updateTask } from '@/lib/ops/core'
import { findJobTitle, normalizeFindParams, type FindLeadsParams } from '@/engine/params'
import { resolveCampaignSearchConfig } from '@/engine/searchConfig'

export interface FindJob {
  id: number
  title: string
  status: string
  assigned_to: string | null
  claimed_by: string | null
  created_by: string | null
  created_at: string
  heartbeat_at: string | null
  finished_at: string | null
  error: string | null
  report: string | null
  params: FindLeadsParams
  run: {
    id: number
    status: string
    stage: string | null
    counters: Record<string, unknown>
    notes: string[]
    started_at: string
    heartbeat_at: string | null
    error: string | null
  } | null
}

const JOB_SQL = `
  select t.id, t.title, t.status, t.assigned_to, t.claimed_by, t.created_by, t.created_at, t.heartbeat_at, t.finished_at,
         t.error, t.report, t.payload as params,
         case when r.id is null then null else jsonb_build_object(
           'id', r.id, 'status', r.status, 'stage', r.stage, 'counters', r.counters, 'notes', r.notes,
           'started_at', r.started_at, 'heartbeat_at', r.heartbeat_at, 'error', r.error) end as run
    from lp.tasks t left join lp.engine_runs r on r.task_id = t.id
   where t.kind = 'find_leads'`

export async function listFindJobs(q: Queryable, limit = 25): Promise<FindJob[]> {
  const { rows } = await q.query<FindJob>(`${JOB_SQL} order by t.id desc limit $1`, [limit])
  return rows
}

export async function getFindJob(q: Queryable, id: number): Promise<FindJob | null> {
  const { rows } = await q.query<FindJob>(`${JOB_SQL} and t.id = $1`, [id])
  return rows[0] ?? null
}

export async function createFindJob(db: Db, actor: string, raw: unknown): Promise<FindJob> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawCampaignId = Number(o.campaign_id)
  const campaignId = Number.isInteger(rawCampaignId) && rawCampaignId > 0 ? rawCampaignId : null
  // APPROVED campaign-profile items win over the pool's built-in default list
  // (engine/searchConfig.ts); a run not started for a campaign keeps today's
  // behavior (explicit queries, else the pool's built-in default).
  const resolved = campaignId ? await resolveCampaignSearchConfig(db, campaignId) : undefined
  const params = normalizeFindParams(raw, resolved)
  const assigned = typeof o.assigned_to === 'string' && o.assigned_to.trim() ? o.assigned_to.trim() : 'tab'
  const t = await createTask(db, actor, {
    kind: 'find_leads',
    title: findJobTitle(params),
    assigned_to: assigned,
    payload: params as unknown as Record<string, unknown>,
    max_attempts: 5,
  })
  return (await getFindJob(db, t.id)) as FindJob
}

export async function cancelFindJob(db: Db, actor: string, id: number): Promise<FindJob | null> {
  const job = await getFindJob(db, id)
  if (!job) return null
  if (['done', 'failed', 'cancelled'].includes(job.status)) throw new OpsError(`this job is already ${job.status}`, 409)
  await updateTask(db, actor, id, { status: 'cancelled' })
  return getFindJob(db, id)
}

export interface EnqueueResult {
  queued: { company_id: number; task_id: number }[]
  already: number[]
  missing: number[]
}

/** One research_company task per company (dedupe key research:<id>), assigned to Tab unless told otherwise. */
export async function enqueueResearch(db: Db, actor: string, companyIds: number[], assignedTo = 'tab'): Promise<EnqueueResult> {
  const out: EnqueueResult = { queued: [], already: [], missing: [] }
  const ids = [...new Set(companyIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000)
  if (!ids.length) return out
  const { rows } = await db.query<{ id: number; name: string; website: string | null; city: string | null; state: string | null }>(
    'select id, name, website, city, state from lp.companies where id = any($1::bigint[])',
    [ids],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    const c = byId.get(id)
    if (!c) {
      out.missing.push(id)
      continue
    }
    try {
      const t = await createTask(db, actor, {
        kind: 'research_company',
        title: `Research ${c.name}`.slice(0, 300),
        assigned_to: assignedTo,
        company_id: c.id,
        dedupe_key: `research:${c.id}`,
        payload: { name: c.name, website: c.website, city: c.city, state: c.state },
      })
      await db.query("update lp.companies set research_status = 'queued' where id = $1 and research_status <> 'researching'", [c.id])
      out.queued.push({ company_id: c.id, task_id: t.id })
    } catch (e) {
      if (e instanceof OpsError && e.status === 409) out.already.push(id)
      else throw e
    }
  }
  return out
}

/**
 * Time left, only when measured: the current stage's own pace in this run
 * (items finished since the stage started), after at least 5 items. null otherwise.
 */
export function measuredEta(job: FindJob, now = Date.now()): { seconds: number; basis: string } | null {
  const r = job.run
  if (!r || r.status !== 'running') return null
  const c = r.counters as Record<string, number | string | undefined>
  const started = typeof c.stage_started_at === 'string' ? Date.parse(c.stage_started_at) : NaN
  if (!Number.isFinite(started)) return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const kept = num(c.kept)
  const doneIn: Record<string, number | null> = { crawl: num(c.crawled), owner: num(c.owner_checked), build: num(c.built) }
  const stage = r.stage ?? ''
  if (!(stage in doneIn) || kept == null) return null
  const doneNow = doneIn[stage]
  if (doneNow == null) return null
  const elapsed = (now - started) / 1000
  if (doneNow < 5 || elapsed <= 0) return null
  const left = Math.max(0, kept - doneNow)
  return { seconds: Math.round((left / doneNow) * elapsed), basis: `${doneNow} done in ${Math.round(elapsed)} s this stage` }
}
