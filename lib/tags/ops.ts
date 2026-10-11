/**
 * Tag ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts): list_tags, add_tag, remove_tag, rename_tag, merge_tags,
 * set_tag_style, tag_trends, change_tag. One spread line in lib/ops/dispatch.ts.
 *
 * Renaming or merging a tag on EVERY lead is an owner's explicit choice
 * (Yaakov, Oct 11, 2026): rename_tag / merge_tags refuse any caller that is
 * not an active human owner, and need expected_count. Agents change a tag on
 * one lead, on chosen leads or on a segment with change_tag (preview first).
 */
import type { Db } from '@/lib/db/types'
import { OpsError } from '@/lib/ops/core'
import { addTag, changeTagOnLeads, countLeadsWithAnyTag, listTags, mergeTags, previewTagChange, removeTag, renameTag, setTagStyle, tagTrends, TagError } from './store'

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

function optInt(v: unknown, field: string): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new OpsError(`${field} must be a whole number`)
  return n
}

function scopeOf(a: Args) {
  return {
    company_id: a.company_id == null ? null : posInt(a.company_id, 'company_id'),
    company_ids: a.company_ids == null ? null : (Array.isArray(a.company_ids) ? a.company_ids : []).map((x) => posInt(x, 'company_ids')),
    segment_id: a.segment_id == null ? null : posInt(a.segment_id, 'segment_id'),
  }
}

async function requireHumanOwner(db: Db, actor: string): Promise<void> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select true as ok from lp.actors where id = $1 and kind = 'human' and active and role = 'owner'`,
    [actor],
  )
  if (!rows[0]) {
    throw new OpsError(
      'Renaming or merging a tag on every lead is an owner choice, made in the dashboard (Settings > Tags) with a confirm. Use change_tag with company_id, company_ids or segment_id instead.',
      403,
    )
  }
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
  change_tag: {
    args: '{from, to, company_id? | company_ids?: number[] | segment_id?, preview?: boolean, expected_count?}  -- change a tag on one lead, on chosen leads, or on a segment\'s leads only. preview:true returns {count} and changes nothing; a change to more than one lead needs expected_count = that count. One audit entry, no per-lead timeline rows.',
    run: wrap(async (db, actor, a) => {
      const scope = scopeOf(a)
      if (a.preview === true) return previewTagChange(db, { from: String(a.from ?? ''), ...scope })
      return changeTagOnLeads(db, actor, { from: String(a.from ?? ''), to: String(a.to ?? ''), expected_count: optInt(a.expected_count, 'expected_count'), via: 'ops_api', ...scope })
    }),
  },
  rename_tag: {
    args: '{from, to, expected_count}  -- OWNER ONLY (a human owner key): renames the tag on every lead carrying it. expected_count must equal how many leads carry it now. One audit entry, no per-lead timeline rows. Agents: use change_tag.',
    run: wrap(async (db, actor, a) => {
      await requireHumanOwner(db, actor)
      return renameTag(db, actor, { from: String(a.from ?? ''), to: String(a.to ?? ''), expected_count: optInt(a.expected_count, 'expected_count'), via: 'ops_api' })
    }),
  },
  merge_tags: {
    args: '{tags: [string,...], into, expected_count}  -- OWNER ONLY: merges the tags into one on every lead carrying any of them. expected_count must equal that number of leads now. One audit entry.',
    run: wrap(async (db, actor, a) => {
      const tags = strList(a.tags, 'tags')
      await requireHumanOwner(db, actor)
      return mergeTags(db, actor, { tags, into: String(a.into ?? ''), expected_count: optInt(a.expected_count, 'expected_count'), via: 'ops_api' })
    }),
  },
  count_tagged: {
    args: '{tags: [string,...]}  -- how many leads carry any of these tags now',
    run: wrap(async (db, _actor, a) => ({ count: await countLeadsWithAnyTag(db, strList(a.tags, 'tags')) })),
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
