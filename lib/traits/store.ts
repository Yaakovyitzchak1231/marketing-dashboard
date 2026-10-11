/**
 * CRUD on lp.traits (migration 0033), same shape as lib/segments/store.ts:
 * every write names its actor and leaves a row in the universal audit log
 * (lp.status_history, entity_type 'trait' -- added to the Phase 2 canonical
 * entity_type list by this slice's migration; see PHASE2_COMMON.md's last
 * section). `define_trait` is upsert-by-key: redefining an existing trait's
 * rules is normal use (the builder's "preview, then save"), not an edit flow
 * with its own patch shape.
 */
import type { Queryable } from '../db/types.ts'
import { validateTraitDefinition, validateTraitEntity, validateTraitKey, type TraitDefinition, type TraitEntity } from './definition.ts'

export interface Trait {
  key: string
  label: string
  entity: TraitEntity
  definition: TraitDefinition
  archived_at: string | null
  last_computed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export class TraitError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const COLS = 'key, label, entity, definition, archived_at, last_computed_at, created_by, created_at, updated_at'

function parseRow(r: Record<string, unknown>): Trait {
  return { ...r, definition: r.definition as TraitDefinition } as Trait
}

async function logHistory(q: Queryable, key: string, field: string, oldV: unknown, newV: unknown, actor: string, via: 'ui' | 'ops_api'): Promise<void> {
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
     values ('trait', $1, $2, $3, $4, $5, $6)`,
    [key, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), actor, via],
  )
}

export async function listTraits(q: Queryable, opts: { includeArchived?: boolean } = {}): Promise<Trait[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select ${COLS} from lp.traits where ($1 or archived_at is null) order by key`,
    [Boolean(opts.includeArchived)],
  )
  return rows.map(parseRow)
}

export async function getTrait(q: Queryable, key: string): Promise<Trait | null> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${COLS} from lp.traits where key = $1`, [key])
  return rows[0] ? parseRow(rows[0]) : null
}

export interface DefineTraitInput {
  key: string
  label: string
  entity: string
  definition: unknown
}

/** Create a trait, or redefine an existing one's label/entity/rules (upsert by key).
 *  Redefining does NOT recompute values itself -- call recompute_traits after, or let
 *  the 'traits_refresh' job pick it up (its next run sees last_computed_at unchanged
 *  isn't true for an existing key, so this resets it to null, forcing a full recompute
 *  of the new rules rather than silently keeping stale values under a changed definition). */
export async function defineTrait(q: Queryable, actor: string, input: DefineTraitInput, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Trait> {
  const key = validateTraitKey(input.key)
  const label = String(input.label ?? '').trim()
  if (!label || label.length > 80) throw new TraitError('label is required (1-80 characters).')
  const entity = validateTraitEntity(input.entity)
  const definition = validateTraitDefinition(input.definition)
  const existing = await getTrait(q, key)
  const { rows } = await q.query<Record<string, unknown>>(
    `insert into lp.traits (key, label, entity, definition, created_by)
       values ($1, $2, $3, $4, $5)
     on conflict (key) do update set
       label = excluded.label, entity = excluded.entity, definition = excluded.definition,
       archived_at = null, last_computed_at = null
     returning ${COLS}`,
    [key, label, entity, JSON.stringify(definition), actor],
  )
  const trait = parseRow(rows[0])
  if (!existing) {
    await logHistory(q, key, 'created', null, label, actor, via)
  } else {
    if (existing.label !== label) await logHistory(q, key, 'label', existing.label, label, actor, via)
    if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) await logHistory(q, key, 'definition', 'changed', 'changed', actor, via)
    if (existing.archived_at) await logHistory(q, key, 'archived_at', existing.archived_at, null, actor, via)
  }
  return trait
}

export async function archiveTrait(q: Queryable, actor: string, key: string, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Trait> {
  const cur = await getTrait(q, key)
  if (!cur) throw new TraitError(`No trait "${key}".`, 404)
  if (cur.archived_at) return cur
  const { rows } = await q.query<Record<string, unknown>>(`update lp.traits set archived_at = now() where key = $1 returning ${COLS}`, [key])
  await logHistory(q, key, 'archived_at', null, 'now', actor, via)
  return parseRow(rows[0])
}
