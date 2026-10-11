/**
 * CRUD on lp.segments (migration 0024), with the same shape as lib/pools/store.ts:
 * every write names its actor and leaves a row in the universal audit log
 * (lp.status_history, entity_type 'segment' -- already in its check constraint,
 * migration 0017).
 */
import type { Queryable } from '../db/types.ts'
import { validateDefinition, type SegmentDefinition } from './definition.ts'

export interface Segment {
  id: number
  name: string
  description: string | null
  kind: 'dynamic' | 'static'
  campaign_id: number | null
  entity: 'company' | 'contact'
  definition: SegmentDefinition
  is_preset: boolean
  preset_key: string | null
  archived_at: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export class SegmentError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const COLS = 'id, name, description, kind, campaign_id, entity, definition, is_preset, preset_key, archived_at, created_by, updated_by, created_at, updated_at'

function parseRow(r: Record<string, unknown>): Segment {
  return { ...r, definition: r.definition as SegmentDefinition } as Segment
}

export async function listSegments(
  q: Queryable,
  opts: { includeArchived?: boolean; campaignId?: number | null } = {},
): Promise<Segment[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select ${COLS} from lp.segments
      where ($1 or archived_at is null) and ($2::bigint is null or campaign_id = $2 or campaign_id is null)
      order by name`,
    [Boolean(opts.includeArchived), opts.campaignId ?? null],
  )
  return rows.map(parseRow)
}

export async function getSegment(q: Queryable, id: number): Promise<Segment | null> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${COLS} from lp.segments where id = $1`, [id])
  return rows[0] ? parseRow(rows[0]) : null
}

async function logHistory(q: Queryable, id: number, field: string, oldV: unknown, newV: unknown, actor: string, via: 'ui' | 'ops_api'): Promise<void> {
  await q.query(
    `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via)
     values ('segment', $1, $2, $3, $4, $5, $6)`,
    [id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), actor, via],
  )
}

export interface CreateSegmentInput {
  name: string
  description?: string | null
  kind?: 'dynamic' | 'static'
  campaign_id?: number | null
  entity: 'company' | 'contact'
  definition: unknown
  is_preset?: boolean
  preset_key?: string | null
}

export async function createSegment(q: Queryable, actor: string, input: CreateSegmentInput, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Segment> {
  const name = String(input.name ?? '').trim()
  if (!name || name.length > 120) throw new SegmentError('name is required (1-120 characters).')
  const entity = input.entity === 'contact' ? 'contact' : input.entity === 'company' ? 'company' : null
  if (!entity) throw new SegmentError('entity must be "company" or "contact".')
  const definition = validateDefinition(input.definition)
  if (definition.entity !== entity) throw new SegmentError(`definition.entity ("${definition.entity}") must match entity ("${entity}").`)
  const kind = input.kind === 'static' ? 'static' : 'dynamic'
  const description = input.description == null || input.description === '' ? null : String(input.description).trim().slice(0, 2000)
  const campaignId = input.campaign_id == null ? null : Number(input.campaign_id)
  if (campaignId != null && (!Number.isInteger(campaignId) || campaignId <= 0)) throw new SegmentError('campaign_id must be a positive integer, or omitted for all campaigns.')
  const { rows } = await q.query<Record<string, unknown>>(
    `insert into lp.segments (name, description, kind, campaign_id, entity, definition, is_preset, preset_key, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning ${COLS}`,
    [name, description, kind, campaignId, entity, JSON.stringify(definition), Boolean(input.is_preset), input.preset_key ?? null, actor],
  )
  const seg = parseRow(rows[0])
  await logHistory(q, seg.id, 'created', null, name, actor, via)
  return seg
}

export interface UpdateSegmentPatch {
  name?: string
  description?: string | null
  campaign_id?: number | null
  definition?: unknown
}

export async function updateSegment(q: Queryable, actor: string, id: number, patch: UpdateSegmentPatch, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Segment> {
  const cur = await getSegment(q, id)
  if (!cur) throw new SegmentError(`No segment ${id}.`, 404)
  if (cur.archived_at) throw new SegmentError(`Segment ${id} is archived; unarchive is not supported yet.`, 409)
  const name = patch.name === undefined ? cur.name : String(patch.name).trim()
  if (!name || name.length > 120) throw new SegmentError('name must be 1-120 characters.')
  const description = patch.description === undefined ? cur.description : patch.description === null || patch.description === '' ? null : String(patch.description).trim().slice(0, 2000)
  const campaignId = patch.campaign_id === undefined ? cur.campaign_id : patch.campaign_id == null ? null : Number(patch.campaign_id)
  if (campaignId != null && (!Number.isInteger(campaignId) || campaignId <= 0)) throw new SegmentError('campaign_id must be a positive integer, or null for all campaigns.')
  const definition = patch.definition === undefined ? cur.definition : validateDefinition(patch.definition)
  if (patch.definition !== undefined && definition.entity !== cur.entity) throw new SegmentError(`definition.entity must stay "${cur.entity}" (a segment's entity cannot change).`)
  const { rows } = await q.query<Record<string, unknown>>(
    `update lp.segments set name = $2, description = $3, campaign_id = $4, definition = $5, updated_by = $6
       where id = $1 returning ${COLS}`,
    [id, name, description, campaignId, JSON.stringify(definition), actor],
  )
  const next = parseRow(rows[0])
  if (name !== cur.name) await logHistory(q, id, 'name', cur.name, name, actor, via)
  if (description !== cur.description) await logHistory(q, id, 'description', cur.description, description, actor, via)
  if (campaignId !== cur.campaign_id) await logHistory(q, id, 'campaign_id', cur.campaign_id, campaignId, actor, via)
  if (patch.definition !== undefined && JSON.stringify(cur.definition) !== JSON.stringify(definition)) {
    await logHistory(q, id, 'definition', 'changed', 'changed', actor, via)
  }
  return next
}

export async function archiveSegment(q: Queryable, actor: string, id: number, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Segment> {
  const cur = await getSegment(q, id)
  if (!cur) throw new SegmentError(`No segment ${id}.`, 404)
  if (cur.archived_at) return cur
  const { rows } = await q.query<Record<string, unknown>>(
    `update lp.segments set archived_at = now(), updated_by = $2 where id = $1 returning ${COLS}`,
    [id, actor],
  )
  await logHistory(q, id, 'archived_at', null, 'now', actor, via)
  return parseRow(rows[0])
}
