/**
 * Ops for the universal inline-edit + audit log (plan item 1.3): update_entity,
 * update_entity_fields, entity_history, recent_changes. One spread line in
 * lib/ops/dispatch.ts, the way lib/campaigns/ops.ts does it.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import { updateEntity, updateEntityFields } from './update'
import { entityHistory, recentChanges } from './history'
import { RegistryError } from './registry'
import { LeadEditError } from '../leads/edit'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

/** RegistryError/LeadEditError -> OpsError with the same status, so the ops route answers 400/404/409. */
function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof RegistryError) throw new OpsError(e.message, e.status)
      if (e instanceof LeadEditError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function idArg(v: unknown): string | number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim()) return v.trim()
  throw new OpsError('id is required')
}

export const EDIT_OPS: Record<string, Op> = {
  update_entity: {
    args: '{type, id, field, value, note?}  -- {type,id,field,value} with a per-type whitelist; agents write as themselves',
    run: wrap((db, actor, a) =>
      updateEntity(db, actor, {
        type: String(a.type ?? ''),
        id: idArg(a.id),
        field: String(a.field ?? ''),
        value: a.value,
        via: 'ops_api',
        note: typeof a.note === 'string' ? a.note : null,
      }),
    ),
  },
  update_entity_fields: {
    args: '{type, id, fields: {field: value, ...}, note?}  -- several fields on one entity, one call',
    run: wrap((db, actor, a) =>
      updateEntityFields(db, actor, {
        type: String(a.type ?? ''),
        id: idArg(a.id),
        fields: (a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields) ? (a.fields as Record<string, unknown>) : null) ?? (() => {
          throw new OpsError('fields must be an object of field -> value')
        })(),
        via: 'ops_api',
        note: typeof a.note === 'string' ? a.note : null,
      }),
    ),
  },
  entity_history: {
    args: '{type, id, limit?, before?}  -> this entity\'s status_history rows, newest first',
    run: wrap((db, _actor, a) => entityHistory(db, String(a.type ?? ''), idArg(a.id), { limit: a.limit == null ? undefined : Number(a.limit), before: a.before == null ? undefined : Number(a.before) })),
  },
  recent_changes: {
    args: '{actor?, type?, limit?}  -> status_history rows across every entity, newest first',
    run: wrap((db, _actor, a) =>
      recentChanges(db, {
        actor: typeof a.actor === 'string' ? a.actor : undefined,
        type: typeof a.type === 'string' ? a.type : undefined,
        limit: a.limit == null ? undefined : Number(a.limit),
      }),
    ),
  },
}
