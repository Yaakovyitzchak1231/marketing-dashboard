/**
 * Tags as first-class (plan 2.9): companies.tags stays the array on the row
 * (migration 0011); lp.tag_defs (0031_tags.sql) adds colour/description for
 * tags that have been styled.
 *
 * Changing a tag on many leads is always an explicit choice with a count
 * (Yaakov, Oct 11, 2026): changeTagOnLeads changes it on ONE lead, or on the
 * leads the user selected / a segment they picked, and renameTag / mergeTags
 * change it everywhere (owner-only, in the action and the ops door). Every
 * many-lead change needs `expected_count` -- the number the user saw and
 * confirmed -- and is refused if the real count has moved. Each action writes
 * ONE lp.status_history row (entity_type 'tag': who, old name, new name, how
 * many leads) and no per-lead timeline rows. add_tag / remove_tag on a single
 * lead still emit tag_added / tag_removed.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { emitLeadEvent } from '@/lib/events/emit'
import { companyIdsForDefinition } from '@/lib/segments/match-companies'

export class TagError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'TagError'
  }
}

export interface TagRow {
  tag: string
  colour: string | null
  description: string | null
  count: number
}

const TAG_RE = /^.{1,60}$/

function cleanTag(raw: unknown, field = 'tag'): string {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!t || !TAG_RE.test(t)) throw new TagError(`${field} must be 1-60 characters`)
  return t
}

/** Every tag in use (from companies.tags) or styled (lp.tag_defs), with its live count and any styling. */
export async function listTags(q: Queryable): Promise<TagRow[]> {
  const { rows } = await q.query<TagRow>(
    `with used as (
       select t as tag, count(*)::int as count from lp.companies c, unnest(c.tags) as t group by t
     )
     select coalesce(u.tag, d.tag) as tag, d.colour, d.description, coalesce(u.count, 0) as count
     from used u
     full outer join lp.tag_defs d on d.tag = u.tag
     order by coalesce(u.count, 0) desc, coalesce(u.tag, d.tag)`,
  )
  return rows
}

async function writeTagHistory(q: Queryable, tag: string, field: string, from: string | null, to: string | null, actor: string, note: string, via: 'ui' | 'ops_api' = 'ops_api') {
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via, note)
     values ('tag', $1, $2, $3, $4, $5, $6, $7)`,
    [tag, field, from, to, actor, via, note],
  )
}

async function companiesWithTag(q: Queryable, tag: string): Promise<{ id: number; tags: string[] }[]> {
  const { rows } = await q.query<{ id: number; tags: string[] }>(`select id, tags from lp.companies where $1 = any(tags) and merged_into is null`, [tag])
  return rows
}

/** Add one tag to one company. Creates the tag_defs row if styling is given; emits tag_added. */
export async function addTag(db: Db, actor: string, input: { company_id: number; tag: string; colour?: string | null; description?: string | null }): Promise<{ tags: string[] }> {
  const tag = cleanTag(input.tag)
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; tags: string[] }>(
      `update lp.companies set tags = case when $1 = any(tags) then tags else array_append(tags, $1) end
       where id = $2 returning id, tags`,
      [tag, input.company_id],
    )
    if (!rows[0]) throw new TagError(`No company ${input.company_id}.`, 404)
    await q.query(`insert into lp.tag_defs (tag, colour, description, created_by) values ($1,$2,$3,$4) on conflict (tag) do nothing`, [tag, input.colour ?? null, input.description ?? null, actor])
    await emitLeadEvent(q, { type: 'tag_added', company_id: input.company_id, source: 'ops_api', actor, props: { tag } })
    return { tags: rows[0].tags }
  }, actor)
}

/** Remove one tag from one company. Emits tag_removed. */
export async function removeTag(db: Db, actor: string, input: { company_id: number; tag: string }): Promise<{ tags: string[] }> {
  const tag = cleanTag(input.tag)
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; tags: string[] }>(`update lp.companies set tags = array_remove(tags, $1) where id = $2 returning id, tags`, [tag, input.company_id])
    if (!rows[0]) throw new TagError(`No company ${input.company_id}.`, 404)
    await emitLeadEvent(q, { type: 'tag_removed', company_id: input.company_id, source: 'ops_api', actor, props: { tag } })
    return { tags: rows[0].tags }
  }, actor)
}

export type TagVia = 'ui' | 'ops_api'

function plural(n: number): string {
  return `${n} lead${n === 1 ? '' : 's'}`
}

function checkExpected(expected: number | null | undefined, actual: number, required: boolean): void {
  if (expected == null) {
    if (required) throw new TagError(`This changes ${plural(actual)}. Confirm the count (expected_count: ${actual}) to go ahead.`, 409)
    return
  }
  if (!Number.isInteger(expected) || expected < 0) throw new TagError('expected_count must be a whole number')
  if (expected !== actual) throw new TagError(`The number of leads changed: you confirmed ${expected}, it is now ${actual}. Check again and confirm the new count.`, 409)
}

async function carryStyle(q: Queryable, from: string, to: string, actor: string): Promise<void> {
  const { rows: defRows } = await q.query<{ colour: string | null; description: string | null }>(`select colour, description from lp.tag_defs where tag = $1`, [from])
  await q.query(
    `insert into lp.tag_defs (tag, colour, description, created_by) values ($1,$2,$3,$4)
     on conflict (tag) do update set colour = coalesce(lp.tag_defs.colour, excluded.colour), description = coalesce(lp.tag_defs.description, excluded.description)`,
    [to, defRows[0]?.colour ?? null, defRows[0]?.description ?? null, actor],
  )
}

/** Replace `from` with `to` on exactly these companies (set-based; keeps position; no duplicates). */
async function replaceOn(q: Queryable, ids: number[], from: string, to: string): Promise<void> {
  if (!ids.length) return
  await q.query(
    `update lp.companies
        set tags = case when $2 = any(tags) then array_remove(tags, $1) else array_replace(tags, $1, $2) end
      where id = any($3::bigint[]) and $1 = any(tags) and merged_into is null`,
    [from, to, ids],
  )
}

/** Which leads a tag change should touch. One lead, the leads the user selected, or a segment (static list = its members; dynamic = its rules). */
/** Most leads an Editor (or an agent key) may retag in one change. Owners are not limited (Phase 2 review, #87 finding 6). */
export const EDITOR_TAG_CHANGE_CAP = 500

/** A dynamic segment matching more than this is refused for a tag change, so the confirm count is never a truncated set. */
export const MAX_SEGMENT_TAG_SCOPE = 30_000

/** Who is making a tag change. Default is the safe one: not an owner, so capped. */
export interface TagChangeActor {
  isOwner: boolean
}

export function editorCapMessage(n: number): string {
  return `This changes ${plural(n)}. Changes over ${EDITOR_TAG_CHANGE_CAP} leads need an owner.`
}

export interface TagScope {
  company_id?: number | null
  company_ids?: number[] | null
  segment_id?: number | null
}

async function scopeCompanyIds(q: Queryable, scope: TagScope): Promise<{ ids: number[]; label: string; single: boolean }> {
  const given = [scope.company_id != null, scope.company_ids != null, scope.segment_id != null].filter(Boolean).length
  if (given !== 1) throw new TagError('Pick exactly one: one lead (company_id), selected leads (company_ids) or a segment (segment_id).')
  if (scope.company_id != null) {
    const id = Number(scope.company_id)
    if (!Number.isInteger(id) || id <= 0) throw new TagError('company_id must be a positive integer')
    return { ids: [id], label: `lead #${id}`, single: true }
  }
  if (scope.company_ids != null) {
    const ids = [...new Set(scope.company_ids.map(Number))]
    if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new TagError('company_ids must be a non-empty list of positive integers')
    return { ids, label: `${ids.length} selected lead${ids.length === 1 ? '' : 's'}`, single: false }
  }
  const segId = Number(scope.segment_id)
  if (!Number.isInteger(segId) || segId <= 0) throw new TagError('segment_id must be a positive integer')
  const { rows } = await q.query<{ id: number; name: string; kind: string; definition: unknown }>(
    `select id, name, kind, definition from lp.segments where id = $1 and archived_at is null`,
    [segId],
  )
  const seg = rows[0]
  if (!seg) throw new TagError(`No segment ${segId}.`, 404)
  let ids: number[]
  if (seg.kind === 'static') {
    const m = await q.query<{ id: number }>(
      `select distinct coalesce(sm.company_id, ct.company_id) as id
         from lp.segment_members sm left join lp.contacts ct on ct.id = sm.contact_id
        where sm.segment_id = $1 and coalesce(sm.company_id, ct.company_id) is not null`,
      [segId],
    )
    ids = m.rows.map((r) => Number(r.id))
  } else {
    ids = await companyIdsForDefinition(q, seg.definition, MAX_SEGMENT_TAG_SCOPE + 1)
    if (ids.length > MAX_SEGMENT_TAG_SCOPE) throw new TagError(`That segment matches more than ${MAX_SEGMENT_TAG_SCOPE} leads. Use a narrower segment.`)
  }
  return { ids, label: `segment "${seg.name}"`, single: false }
}

async function targetsCarrying(q: Queryable, ids: number[], tag: string): Promise<number[]> {
  if (!ids.length) return []
  const { rows } = await q.query<{ id: number }>(`select id from lp.companies where id = any($1::bigint[]) and $2 = any(tags) and merged_into is null order by id`, [ids, tag])
  return rows.map((r) => Number(r.id))
}

/** How many leads in the scope carry `from` right now -- the count the confirm step shows. Changes nothing. */
export async function previewTagChange(q: Queryable, input: { from: string } & TagScope): Promise<{ count: number; scope: string }> {
  const from = cleanTag(input.from, 'from')
  const { ids, label } = await scopeCompanyIds(q, input)
  return { count: (await targetsCarrying(q, ids, from)).length, scope: label }
}

/**
 * Change tag `from` to `to` on one lead, or on the selected leads / a segment
 * (with `expected_count` confirmed). Leads outside the scope keep `from`.
 * One audit row; no per-lead timeline rows. A non-owner (`who`, default not an
 * owner) may change at most EDITOR_TAG_CHANGE_CAP leads in one go.
 */
export async function changeTagOnLeads(
  db: Db,
  actor: string,
  input: { from: string; to: string; expected_count?: number | null; via?: TagVia } & TagScope,
  who: TagChangeActor = { isOwner: false },
): Promise<{ companies_updated: number; scope: string }> {
  const from = cleanTag(input.from, 'from')
  const to = cleanTag(input.to, 'to')
  if (from === to) throw new TagError('from and to are the same tag')
  return db.tx(async (q) => {
    const { ids, label, single } = await scopeCompanyIds(q, input)
    if (single) {
      const exists = await q.query(`select 1 from lp.companies where id = $1 and merged_into is null`, [ids[0]])
      if (!exists.rows.length) throw new TagError(`No company ${ids[0]}.`, 404)
    }
    const targets = await targetsCarrying(q, ids, from)
    checkExpected(input.expected_count, targets.length, !single)
    if (!targets.length) throw new TagError(single ? `That lead doesn't have the tag "${from}".` : `None of those leads has the tag "${from}".`, 404)
    if (!who.isOwner && targets.length > EDITOR_TAG_CHANGE_CAP) throw new TagError(editorCapMessage(targets.length), 403)
    await replaceOn(q, targets, from, to)
    await q.query(`insert into lp.tag_defs (tag, created_by) values ($1,$2) on conflict (tag) do nothing`, [to, actor])
    await writeTagHistory(q, from, 'change', from, to, actor, `changed "${from}" to "${to}" on ${plural(targets.length)} (${label})`, input.via)
    return { companies_updated: targets.length, scope: label }
  }, actor)
}

/** How many leads carry each tag now: the count a rename / merge confirm step shows. */
export async function countLeadsWithAnyTag(q: Queryable, tags: string[]): Promise<number> {
  const clean = [...new Set(tags.map((t) => cleanTag(t)))]
  const { rows } = await q.query<{ n: number }>(`select count(*)::int as n from lp.companies where tags && $1::text[] and merged_into is null`, [clean])
  return rows[0]?.n ?? 0
}

/**
 * Rename a tag on EVERY lead that carries it. An owner-only, explicit choice:
 * the caller checks the role; `expected_count` (the count the owner confirmed)
 * is required. One audit row; no per-lead timeline rows.
 */
export async function renameTag(db: Db, actor: string, input: { from: string; to: string; expected_count: number | null | undefined; via?: TagVia }): Promise<{ companies_updated: number }> {
  const from = cleanTag(input.from, 'from')
  const to = cleanTag(input.to, 'to')
  if (from === to) throw new TagError('from and to are the same tag')
  return db.tx(async (q) => {
    const targets = (await companiesWithTag(q, from)).map((c) => Number(c.id))
    checkExpected(input.expected_count, targets.length, true)
    await replaceOn(q, targets, from, to)
    await carryStyle(q, from, to, actor)
    await q.query(`delete from lp.tag_defs where tag = $1`, [from])
    await writeTagHistory(q, from, 'rename', from, to, actor, `renamed "${from}" to "${to}" on all ${plural(targets.length)}`, input.via)
    return { companies_updated: targets.length }
  }, actor)
}

/** Merge several tags into one target tag on every lead carrying any of them. Owner-only, `expected_count` required, one audit row. */
export async function mergeTags(db: Db, actor: string, input: { tags: string[]; into: string; expected_count: number | null | undefined; via?: TagVia }): Promise<{ companies_updated: number }> {
  const into = cleanTag(input.into, 'into')
  const sources = [...new Set((input.tags ?? []).map((t) => cleanTag(t)))].filter((t) => t !== into)
  if (!sources.length) throw new TagError('tags must list at least one tag other than "into"')
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number }>(`select id from lp.companies where tags && $1::text[] and merged_into is null`, [sources])
    checkExpected(input.expected_count, rows.length, true)
    await q.query(
      `update lp.companies c
          set tags = (select coalesce(array_agg(t order by min_ord), '{}') from (
                        select case when x.t = any($1::text[]) then $2 else x.t end as t, min(x.ord) as min_ord
                          from unnest(c.tags) with ordinality as x(t, ord)
                         group by 1) d)
        where c.tags && $1::text[] and c.merged_into is null`,
      [sources, into],
    )
    await q.query(`insert into lp.tag_defs (tag, created_by) values ($1,$2) on conflict (tag) do nothing`, [into, actor])
    await q.query(`delete from lp.tag_defs where tag = any($1::text[])`, [sources])
    await writeTagHistory(q, into, 'merge', sources.join(', '), into, actor, `merged ${sources.map((s) => `"${s}"`).join(', ')} into "${into}" on ${plural(rows.length)}`, input.via)
    return { companies_updated: rows.length }
  }, actor)
}

/** Set a tag's colour and/or description (creates the tag_defs row if it doesn't exist yet). */
export async function setTagStyle(db: Db, actor: string, input: { tag: string; colour?: string | null; description?: string | null }): Promise<TagRow> {
  const tag = cleanTag(input.tag)
  if (input.colour && !/^#[0-9a-fA-F]{6}$/.test(input.colour)) throw new TagError('colour must be a 6-digit hex code like #4f7cff')
  if (input.description && input.description.length > 500) throw new TagError('description must be 500 characters or fewer')
  return db.tx(async (q) => {
    await q.query(
      `insert into lp.tag_defs (tag, colour, description, created_by) values ($1,$2,$3,$4)
       on conflict (tag) do update set colour = coalesce($2, lp.tag_defs.colour), description = coalesce($3, lp.tag_defs.description)`,
      [tag, input.colour ?? null, input.description ?? null, actor],
    )
    const { rows } = await q.query<{ count: number }>(`select count(*)::int as count from lp.companies where $1 = any(tags)`, [tag])
    const { rows: defRows } = await q.query<{ colour: string | null; description: string | null }>(`select colour, description from lp.tag_defs where tag = $1`, [tag])
    return { tag, colour: defRows[0]?.colour ?? null, description: defRows[0]?.description ?? null, count: rows[0]?.count ?? 0 }
  }, actor)
}

export interface TagTrendRow {
  week: string
  tag: string
  added: number
}

/** Tag-added counts per week, from lp.lead_events, for the Tag Trends table. Last `weeks` weeks (default 8). */
export async function tagTrends(q: Queryable, weeks = 8): Promise<TagTrendRow[]> {
  const n = Number.isInteger(weeks) && weeks > 0 ? weeks : 8
  const { rows } = await q.query<TagTrendRow>(
    `select to_char(date_trunc('week', occurred_at), 'YYYY-MM-DD') as week, props->>'tag' as tag, count(*)::int as added
     from lp.lead_events
     where type = 'tag_added' and occurred_at >= now() - ($1::int * interval '1 week') and props->>'tag' is not null
     group by 1, 2
     order by 1 desc, 3 desc`,
    [n],
  )
  return rows
}
