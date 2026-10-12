/**
 * Plan 3.1: journeys and their versions. Every write names its actor.
 *
 * Status rules:
 *  - draft:   being built. No runs.
 *  - testing: manual/API enrolment only (try it on a few leads); trigger fires are not consumed.
 *  - live:    enrols from its trigger and from manual/segment/API enrolment.
 *  - paused:  runs stay where they are; nothing advances or enters.
 *  - sunset:  nothing new enters; runs already in flight finish.
 * Going to testing or live needs a published version.
 */
import type { Db, Queryable } from '../db/types.ts'
import { validateGraph, type JourneyGraph } from './graph.ts'

export const JOURNEY_STATUSES = ['draft', 'testing', 'live', 'paused', 'sunset'] as const
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number]
export const ENTRY_MODES = ['once', 'multiple'] as const
export type EntryMode = (typeof ENTRY_MODES)[number]

export class JourneyError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface Journey {
  id: number
  name: string
  status: JourneyStatus
  campaign_id: number | null
  trigger_id: number | null
  trigger_cursor: number
  entry_mode: EntryMode
  goal: Record<string, unknown>
  settings: Record<string, unknown>
  current_version: number | null
  approved_version: number | null
  approved_by: string | null
  approved_at: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

const COLS = `id, name, status, campaign_id, trigger_id, trigger_cursor, entry_mode, goal, settings,
  current_version, approved_version, approved_by, approved_at, created_by, updated_by, created_at, updated_at`

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function history(q: Queryable, id: number, field: string, oldV: unknown, newV: unknown, actor: string, via: 'ui' | 'ops_api' | 'runner'): Promise<void> {
  await q.query(
    `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via)
     values ('journey', $1, $2, $3, $4, $5, $6)`,
    [id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), actor, via],
  )
}

export async function getJourney(q: Queryable, id: number): Promise<Journey | null> {
  const { rows } = await q.query<Journey>(`select ${COLS} from lp.journeys where id = $1`, [id])
  return rows[0] ?? null
}

export async function listJourneys(q: Queryable, opts: { campaign_id?: number | null; status?: string | null } = {}): Promise<(Journey & { counts: Record<string, number> })[]> {
  const { rows } = await q.query<Journey & { counts: Record<string, number> | null }>(
    `select ${COLS.split(',').map((c) => 'j.' + c.trim()).join(', ')},
            (select jsonb_object_agg(status, n) from (
               select status, count(*)::int as n from lp.journey_runs r where r.journey_id = j.id group by status
             ) s) as counts
       from lp.journeys j
      where ($1::bigint is null or j.campaign_id = $1)
        and ($2::text is null or j.status = $2)
      order by j.id`,
    [opts.campaign_id ?? null, opts.status ?? null],
  )
  return rows.map((r) => ({ ...r, counts: r.counts ?? {} }))
}

export interface UpsertJourneyInput {
  id?: number | null
  name: string
  campaign_id?: number | null
  trigger_id?: number | null
  entry_mode?: EntryMode
  goal?: Record<string, unknown>
  settings?: Record<string, unknown>
}

export async function upsertJourney(db: Db, actor: string, input: UpsertJourneyInput, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Journey> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 120) throw new JourneyError('name is required (max 120 characters)')
  // An omitted field keeps its stored value on edit; only a create falls back to the defaults.
  if (input.entry_mode != null && !(ENTRY_MODES as readonly string[]).includes(input.entry_mode)) {
    throw new JourneyError(`entry_mode must be one of: ${ENTRY_MODES.join(', ')}`)
  }
  if (input.goal != null && !isObject(input.goal)) throw new JourneyError('goal must be an object')
  if (input.settings != null && !isObject(input.settings)) throw new JourneyError('settings must be an object')
  return db.tx(async (q) => {
    if (input.trigger_id != null) {
      const t = await q.query('select 1 from lp.triggers where id = $1', [input.trigger_id])
      if (!t.rows[0]) throw new JourneyError('no trigger with that id', 404)
    }
    if (input.campaign_id != null) {
      const c = await q.query('select 1 from lp.campaigns where id = $1', [input.campaign_id])
      if (!c.rows[0]) throw new JourneyError('no campaign with that id', 404)
    }
    if (input.id == null) {
      const { rows } = await q.query<Journey>(
        `insert into lp.journeys (name, campaign_id, trigger_id, entry_mode, goal, settings, created_by, updated_by, trigger_cursor)
         values ($1, $2, $3, $4, $5, $6, $7, $7,
                 -- start reading fires from now: a new journey does not replay old ones
                 coalesce((select max(id) from lp.trigger_fires where trigger_id = $3), 0))
         returning ${COLS}`,
        [name, input.campaign_id ?? null, input.trigger_id ?? null, input.entry_mode ?? 'once',
          JSON.stringify(input.goal ?? {}), JSON.stringify(input.settings ?? {}), actor],
      )
      await history(q, rows[0].id, 'created', null, name, actor, via)
      return rows[0]
    }
    const cur = await getJourney(q, input.id)
    if (!cur) throw new JourneyError('no journey with that id', 404)
    const campaignId = input.campaign_id === undefined ? cur.campaign_id : input.campaign_id
    const triggerId = input.trigger_id === undefined ? cur.trigger_id : input.trigger_id
    const mode = input.entry_mode ?? cur.entry_mode
    const triggerChanged = (triggerId ?? null) !== cur.trigger_id
    const { rows } = await q.query<Journey>(
      `update lp.journeys
          set name = $2, campaign_id = $3, trigger_id = $4, entry_mode = $5, goal = $6, settings = $7, updated_by = $8,
              trigger_cursor = case when $9::boolean
                                    then coalesce((select max(id) from lp.trigger_fires where trigger_id = $4), 0)
                                    else trigger_cursor end
        where id = $1
        returning ${COLS}`,
      [input.id, name, campaignId, triggerId, mode,
        JSON.stringify(input.goal ?? cur.goal), JSON.stringify(input.settings ?? cur.settings), actor, triggerChanged],
    )
    for (const f of ['name', 'campaign_id', 'trigger_id', 'entry_mode'] as const) {
      if (String(cur[f] ?? '') !== String(rows[0][f] ?? '')) await history(q, cur.id, f, cur[f], rows[0][f], actor, via)
    }
    return rows[0]
  }, actor)
}

/** Publish a graph as the journey's next version. Runs in flight keep their version. */
export async function publishVersion(
  db: Db, actor: string, journeyId: number, rawGraph: unknown, note: string | null = null, via: 'ui' | 'ops_api' = 'ops_api',
): Promise<{ journey_id: number; version: number; graph: JourneyGraph }> {
  const graph = validateGraph(rawGraph)
  if (note != null && note.length > 500) throw new JourneyError('note can be at most 500 characters')
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; status: string }>('select id, status from lp.journeys where id = $1 for update', [journeyId])
    if (!rows[0]) throw new JourneyError('no journey with that id', 404)
    const v = await q.query<{ version: number }>(
      'select coalesce(max(version), 0) + 1 as version from lp.journey_versions where journey_id = $1',
      [journeyId],
    )
    const version = Number(v.rows[0].version)
    await q.query(
      `insert into lp.journey_versions (journey_id, version, graph, note, published_by) values ($1, $2, $3, $4, $5)`,
      [journeyId, version, JSON.stringify(graph), note, actor],
    )
    await q.query('update lp.journeys set current_version = $2, updated_by = $3 where id = $1', [journeyId, version, actor])
    await history(q, journeyId, 'version', version - 1 || null, version, actor, via)
    return { journey_id: journeyId, version, graph }
  }, actor)
}

/** Owner approval of the journey's current version. The runner checks it before any send-capable node. */
export async function approveCurrentVersion(db: Db, actor: string, journeyId: number): Promise<Journey> {
  return db.tx(async (q) => {
    const cur = await getJourney(q, journeyId)
    if (!cur) throw new JourneyError('no journey with that id', 404)
    if (cur.current_version == null) throw new JourneyError('publish a version before approving it', 409)
    const { rows } = await q.query<Journey>(
      `update lp.journeys set approved_version = $2, approved_by = $3, approved_at = now(), updated_by = $3
        where id = $1 returning ${COLS}`,
      [journeyId, cur.current_version, actor],
    )
    await history(q, journeyId, 'approved_version', cur.approved_version, cur.current_version, actor, 'ops_api')
    return rows[0]
  }, actor)
}

export async function setJourneyStatus(db: Db, actor: string, journeyId: number, status: string, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Journey> {
  if (!(JOURNEY_STATUSES as readonly string[]).includes(status)) throw new JourneyError(`status must be one of: ${JOURNEY_STATUSES.join(', ')}`)
  return db.tx(async (q) => {
    const cur = await getJourney(q, journeyId)
    if (!cur) throw new JourneyError('no journey with that id', 404)
    if ((status === 'live' || status === 'testing') && cur.current_version == null) {
      throw new JourneyError('publish a version first (journey_publish), then set it live or testing', 409)
    }
    if (status === 'draft' && cur.status !== 'draft') {
      const open = await q.query(`select 1 from lp.journey_runs where journey_id = $1 and status in ('active','waiting') limit 1`, [journeyId])
      if (open.rows[0]) throw new JourneyError('this journey has leads in it; pause or sunset it instead of going back to draft', 409)
    }
    const { rows } = await q.query<Journey>(
      `update lp.journeys set status = $2, updated_by = $3 where id = $1 returning ${COLS}`,
      [journeyId, status, actor],
    )
    if (cur.status !== status) await history(q, journeyId, 'status', cur.status, status, actor, via)
    return rows[0]
  }, actor)
}

export async function getVersionGraph(q: Queryable, journeyId: number, version: number): Promise<JourneyGraph | null> {
  const { rows } = await q.query<{ graph: JourneyGraph }>(
    'select graph from lp.journey_versions where journey_id = $1 and version = $2',
    [journeyId, version],
  )
  return rows[0]?.graph ?? null
}

export async function listVersions(q: Queryable, journeyId: number): Promise<{ version: number; note: string | null; published_by: string | null; published_at: string }[]> {
  const { rows } = await q.query<{ version: number; note: string | null; published_by: string | null; published_at: string }>(
    'select version, note, published_by, published_at from lp.journey_versions where journey_id = $1 order by version desc',
    [journeyId],
  )
  return rows
}
