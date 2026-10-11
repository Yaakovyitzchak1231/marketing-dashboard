/**
 * Tag ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts): list_tags, add_tag, remove_tag, rename_tag, merge_tags,
 * set_tag_style, tag_trends. One spread line in lib/ops/dispatch.ts.
 */
import type { Db } from '@/lib/db/types'
import { OpsError } from '@/lib/ops/core'
import { addTag, listTags, mergeTags, removeTag, renameTag, setTagStyle, tagTrends, TagError } from './store'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof TagError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function posInt(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function strList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.length) throw new OpsError(`${field} must be a non-empty array of strings`)
  return v.map((x) => String(x))
}

export const TAG_OPS: Record<string, Op> = {
  list_tags: {
    args: '{}  -- every tag with its live count and any colour/description',
    run: wrap((db) => listTags(db)),
  },
  add_tag: {
    args: '{company_id, tag, colour?, description?}',
    run: wrap((db, actor, a) => addTag(db, actor, { company_id: posInt(a.company_id, 'company_id'), tag: String(a.tag ?? ''), colour: a.colour == null ? null : String(a.colour), description: a.description == null ? null : String(a.description) })),
  },
  remove_tag: {
    args: '{company_id, tag}',
    run: wrap((db, actor, a) => removeTag(db, actor, { company_id: posInt(a.company_id, 'company_id'), tag: String(a.tag ?? '') })),
  },
  rename_tag: {
    args: '{from, to}  -- updates every company carrying "from", audited, tag_removed/tag_added events per lead',
    run: wrap((db, actor, a) => renameTag(db, actor, { from: String(a.from ?? ''), to: String(a.to ?? '') })),
  },
  merge_tags: {
    args: '{tags: [string,...], into}  -- updates every company carrying any listed tag, audited, events per lead',
    run: wrap((db, actor, a) => mergeTags(db, actor, { tags: strList(a.tags, 'tags'), into: String(a.into ?? '') })),
  },
  set_tag_style: {
    args: '{tag, colour?: "#rrggbb", description?}',
    run: wrap((db, actor, a) => setTagStyle(db, actor, { tag: String(a.tag ?? ''), colour: a.colour == null ? null : String(a.colour), description: a.description == null ? null : String(a.description) })),
  },
  tag_trends: {
    args: '{weeks?}  -- tag-added counts per week (default last 8 weeks)',
    run: wrap((db, _actor, a) => tagTrends(db, a.weeks == null ? undefined : Number(a.weeks))),
  },
}
