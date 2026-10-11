/**
 * Ops for custom fields (plan item 1.7): list_fields, define_field, update_field,
 * archive_field. One spread line in lib/ops/dispatch.ts.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import { FieldError, archiveField, defineField, listFieldDefs, updateField } from './store'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof FieldError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

export const FIELD_OPS: Record<string, Op> = {
  list_fields: {
    args: '{entity?: "company"|"contact", campaign_id?, include_archived?}',
    run: wrap((db, _actor, a) =>
      listFieldDefs(db, {
        entity: a.entity === 'company' || a.entity === 'contact' ? a.entity : undefined,
        campaign_id: a.campaign_id === undefined ? undefined : a.campaign_id === null || a.campaign_id === '' ? null : Number(a.campaign_id),
        include_archived: a.include_archived === true || a.include_archived === 'true',
      }),
    ),
  },
  define_field: {
    args: '{entity: "company"|"contact", key, label, type: "text"|"number"|"date"|"select"|"multi_select"|"url"|"boolean", options? (select/multi_select), campaign_id? (null = every campaign), sort?}',
    run: wrap((db, actor, a) =>
      defineField(db, actor, {
        entity: a.entity, key: a.key, label: a.label, type: a.type,
        options: a.options, campaign_id: a.campaign_id as string | number | null | undefined, sort: a.sort as number | undefined,
        via: 'ops_api',
      }),
    ),
  },
  update_field: {
    args: '{id, label?, options?, sort?, campaign_id?}  -- type and key are permanent once created',
    run: wrap((db, actor, a) =>
      updateField(db, actor, {
        id: a.id as string | number, label: a.label, options: a.options, sort: a.sort as number | undefined,
        campaign_id: a.campaign_id as string | number | null | undefined, via: 'ops_api',
      }),
    ),
  },
  archive_field: {
    args: '{id}',
    run: wrap((db, actor, a) => archiveField(db, actor, { id: a.id as string | number, via: 'ops_api' })),
  },
}
