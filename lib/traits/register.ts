/**
 * Wires live traits (lp.traits) into the segment field registry
 * (lib/segments/fields.ts) so "replies_30d > 0" works as a segment condition
 * the moment a trait is defined -- no deploy, no compiler change.
 *
 * Called at the top of every segment-engine entry point that needs the
 * registry up to date (lib/segments/compile.ts's compileSegment, and
 * segment_fields in lib/segments/ops.ts). Cheap: one small table, and
 * re-registering the same key is a no-op overwrite. Traits are archived
 * (lp.traits.archived_at), never hard-deleted, so there is no "a trait
 * vanished between two calls" case to reconcile here.
 */
import type { Queryable } from '../db/types.ts'
import { registerTraitField, unregisterField } from '../segments/fields.ts'
import type { TraitEntity } from './definition.ts'
import { isUndefinedTable } from '../db/errors.ts'

const TRAIT_FIELD_PREFIX = 'trait.'

export function traitFieldKey(traitKey: string): string {
  return `${TRAIT_FIELD_PREFIX}${traitKey}`
}

export async function ensureTraitFieldsRegistered(q: Queryable): Promise<void> {
  let rows: { key: string; label: string; entity: TraitEntity; archived_at: string | null }[]
  try {
    const result = await q.query<{ key: string; label: string; entity: TraitEntity; archived_at: string | null }>(
      `select key, label, entity, archived_at from lp.traits`,
    )
    rows = result.rows
  } catch (e) {
    // Honest-empty-state contract (PHASE2_COMMON.md): a preview deploy, or prod before
    // migration 0033 has run, has no lp.traits table yet. Segments simply have no trait
    // fields available yet -- not a crash.
    if (isUndefinedTable(e)) return
    throw e
  }
  for (const r of rows) {
    const fieldKey = traitFieldKey(r.key)
    if (r.archived_at) {
      unregisterField(fieldKey)
      continue
    }
    registerTraitField({ key: fieldKey, label: r.label, table: r.entity, traitKey: r.key })
  }
}
