/**
 * Checkpoints for a Find-leads run (lp.engine_runs / lp.engine_items, see
 * db/migrations/0002_engine.sql). Every item is written the moment it changes,
 * so a crashed or handed-off run resumes from the rows, never from memory.
 */
import type { Queryable } from '../lib/db/types.ts'
import type { FindLeadsParams } from './params.ts'

export interface EngineRun {
  id: number
  task_id: number
  params: FindLeadsParams
  status: string
  stage: string | null
  counters: Record<string, unknown>
  notes: string[]
  started_at: Date
}

export interface EngineItem {
  id: number
  kind: 'search' | 'place'
  item_key: string
  stage: string
  status: string
  attempts: number
  data: Record<string, unknown>
  error: string | null
  company_id: number | null
}

/** The run for a task: resumed if it exists (params from the first claim win), created otherwise. */
export async function openRun(q: Queryable, taskId: number, params: FindLeadsParams, runner: string): Promise<{ run: EngineRun; resumed: boolean }> {
  const ins = await q.query<EngineRun>(
    `insert into lp.engine_runs (task_id, params, runner, stage, heartbeat_at) values ($1, $2, $3, 'discover', now())
     on conflict (task_id) do nothing returning *`,
    [taskId, JSON.stringify(params), runner],
  )
  if (ins.rows.length) return { run: ins.rows[0], resumed: false }
  const { rows } = await q.query<EngineRun>(
    `update lp.engine_runs set runner = $2, status = 'running', heartbeat_at = now(), finished_at = null, error = null where task_id = $1 returning *`,
    [taskId, runner],
  )
  return { run: rows[0], resumed: true }
}

export async function addNote(q: Queryable, runId: number, note: string): Promise<void> {
  await q.query(
    `update lp.engine_runs set notes = case when notes @> $2::jsonb then notes else notes || $2::jsonb end where id = $1`,
    [runId, JSON.stringify([note])],
  )
}

export async function setStage(q: Queryable, runId: number, stage: string): Promise<void> {
  await q.query(
    `update lp.engine_runs set stage = $2, counters = counters || jsonb_build_object('stage_started_at', now()) where id = $1 and stage is distinct from $2`,
    [runId, stage],
  )
}

export async function insertSearches(q: Queryable, runId: number, items: { key: string; data: Record<string, unknown> }[]): Promise<number> {
  let n = 0
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500)
    const r = await q.query(
      `insert into lp.engine_items (run_id, kind, item_key, stage, data)
       select $1, 'search', k, 'queued', d from unnest($2::text[], $3::jsonb[]) as x(k, d)
       on conflict (run_id, kind, item_key) do nothing`,
      [runId, chunk.map((c) => c.key), chunk.map((c) => JSON.stringify(c.data))],
    )
    n += r.rowCount ?? 0
  }
  return n
}

export async function pendingItems(q: Queryable, runId: number, kind: 'search' | 'place', stage: string, limit: number, maxAttempts = 3): Promise<EngineItem[]> {
  const { rows } = await q.query<EngineItem>(
    `select id, kind, item_key, stage, status, attempts, data, error, company_id from lp.engine_items
      where run_id = $1 and kind = $2 and stage = $3 and status = 'pending' and attempts < $5
      order by id limit $4`,
    [runId, kind, stage, limit, maxAttempts],
  )
  return rows
}

export async function updateItem(
  q: Queryable,
  id: number,
  patch: { stage?: string; status?: string; data?: Record<string, unknown>; error?: string | null; company_id?: number | null; attempt?: boolean },
): Promise<void> {
  await q.query(
    `update lp.engine_items set
       stage = coalesce($2, stage), status = coalesce($3, status),
       data = case when $4::jsonb is null then data else data || $4::jsonb end,
       error = case when $5::boolean then $6 else error end,
       company_id = coalesce($7, company_id),
       attempts = attempts + case when $8 then 1 else 0 end
     where id = $1`,
    [id, patch.stage ?? null, patch.status ?? null, patch.data ? JSON.stringify(patch.data) : null, patch.error !== undefined, patch.error ?? null, patch.company_id ?? null, patch.attempt === true],
  )
}

/** Insert a place found by discovery (kept or dropped with a reason). false when this run already had it. */
export async function insertPlace(q: Queryable, runId: number, key: string, status: 'pending' | 'dropped', data: Record<string, unknown>, reason: string | null): Promise<boolean> {
  const r = await q.query(
    `insert into lp.engine_items (run_id, kind, item_key, stage, status, data, error)
     values ($1, 'place', $2, 'kept', $3, $4, $5) on conflict (run_id, kind, item_key) do nothing returning id`,
    [runId, key, status, JSON.stringify(data), reason],
  )
  return r.rows.length > 0
}

export interface RunCounters {
  searches_total: number
  searches_done: number
  searches_failed: number
  places_seen: number
  kept: number
  dropped: Record<string, number>
  crawled: number
  sites_ok: number
  owner_checked: number
  built: number
  failed: number
  companies_new: number
  emails_new: number
  owners_found: number
  /** Extra owner stages (opt-in): stores checked, names they found, Facebook emails, pattern guesses (held). */
  extras_checked?: number
  extra_names?: number
  facebook_emails?: number
  pattern_guesses?: number
  stage_started_at?: string | null
}

/** Counters computed from the rows themselves (never incremented in memory). */
export async function computeCounters(q: Queryable, runId: number): Promise<RunCounters> {
  const { rows } = await q.query<{ kind: string; stage: string; status: string; n: number; site_ok: number; companies_new: number; emails_new: number; owners: number; extras_checked: number; extra_names: number; facebook_emails: number; pattern_guesses: number }>(
    `select kind, stage, status, count(*)::int as n,
            count(*) filter (where (data->'crawl'->>'site_ok')::boolean)::int as site_ok,
            count(*) filter (where (data->'applied'->>'company_created')::boolean)::int as companies_new,
            coalesce(sum((data->'applied'->>'contacts_created')::int), 0)::int as emails_new,
            count(*) filter (where data->'applied'->>'owner' is not null)::int as owners,
            count(*) filter (where data ? 'extras')::int as extras_checked,
            count(*) filter (where jsonb_typeof(data->'extras'->'review') = 'object'
                               or jsonb_array_length(coalesce(nullif(data->'extras'->'yelp', 'null'::jsonb), '[]'::jsonb)) > 0
                               or jsonb_typeof(data->'extras'->'last') = 'object')::int as extra_names,
            coalesce(sum(jsonb_array_length(coalesce(nullif(data->'extras'->'facebook'->'emails', 'null'::jsonb), '[]'::jsonb))), 0)::int as facebook_emails,
            count(*) filter (where jsonb_typeof(data->'extras'->'pattern') = 'object'
                               and not coalesce((data->'extras'->'pattern'->>'same_person')::boolean, false))::int as pattern_guesses
       from lp.engine_items where run_id = $1 group by kind, stage, status`,
    [runId],
  )
  const drops = await q.query<{ error: string | null; n: number }>(
    `select error, count(*)::int as n from lp.engine_items where run_id = $1 and kind = 'place' and status = 'dropped' group by error`,
    [runId],
  )
  const c: RunCounters = {
    searches_total: 0, searches_done: 0, searches_failed: 0, places_seen: 0, kept: 0, dropped: {}, crawled: 0, sites_ok: 0,
    owner_checked: 0, built: 0, failed: 0, companies_new: 0, emails_new: 0, owners_found: 0,
  }
  const placeStageOrder = ['kept', 'crawled', 'owner', 'extras', 'built']
  const iOwner = placeStageOrder.indexOf('owner')
  const iBuilt = placeStageOrder.indexOf('built')
  for (const r of rows) {
    if (r.kind === 'search') {
      c.searches_total += r.n
      if (r.stage === 'searched') c.searches_done += r.n
      if (r.status === 'failed') c.searches_failed += r.n
      continue
    }
    c.places_seen += r.n
    if (r.status === 'dropped') continue
    c.kept += r.n
    const idx = placeStageOrder.indexOf(r.stage)
    if (idx >= 1) c.crawled += r.n
    if (idx >= iOwner) c.owner_checked += r.n
    if (idx >= iBuilt) c.built += r.n
    if (r.extras_checked) {
      c.extras_checked = (c.extras_checked ?? 0) + r.extras_checked
      c.extra_names = (c.extra_names ?? 0) + r.extra_names
      c.facebook_emails = (c.facebook_emails ?? 0) + r.facebook_emails
      c.pattern_guesses = (c.pattern_guesses ?? 0) + r.pattern_guesses
    }
    if (r.status === 'failed') c.failed += r.n
    c.sites_ok += r.site_ok
    c.companies_new += r.companies_new
    c.emails_new += r.emails_new
    c.owners_found += r.owners
  }
  for (const d of drops.rows) c.dropped[d.error ?? 'unknown'] = d.n
  return c
}

export async function saveCounters(q: Queryable, runId: number): Promise<RunCounters> {
  const c = await computeCounters(q, runId)
  await q.query(
    `update lp.engine_runs set counters = counters || $2::jsonb, heartbeat_at = now() where id = $1`,
    [runId, JSON.stringify(c)],
  )
  return c
}

export async function finishRun(q: Queryable, runId: number, status: 'done' | 'failed' | 'cancelled', error?: string | null): Promise<void> {
  await q.query(
    `update lp.engine_runs set status = $2, stage = case when $2 = 'done' then 'done' else stage end, finished_at = now(), error = $3 where id = $1`,
    [runId, status, error ?? null],
  )
}
