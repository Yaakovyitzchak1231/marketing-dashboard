/**
 * Tags as first-class (plan 2.9): companies.tags stays the array on the row
 * (migration 0011); lp.tag_defs (0031_tags.sql) adds colour/description for
 * tags that have been styled. Rename and merge touch every company row that
 * carries the tag, write one lp.status_history row (entity_type 'tag',
 * entity_key = the tag), and emit tag_added/tag_removed lead events per
 * affected lead so journeys can trigger on tag changes later.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { emitLeadEvent } from '@/lib/events/emit'

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

async function writeTagHistory(q: Queryable, tag: string, field: string, from: string | null, to: string | null, actor: string, note: string) {
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via, note)
     values ('tag', $1, $2, $3, $4, $5, 'ops_api', $6)`,
    [tag, field, from, to, actor, note],
  )
}

async function companiesWithTag(q: Queryable, tag: string): Promise<{ id: number; tags: string[] }[]> {
  const { rows } = await q.query<{ id: number; tags: string[] }>(`select id, tags from lp.companies where $1 = any(tags)`, [tag])
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

/** Rename a tag across every company that carries it. One audit row, tag_removed+tag_added per affected lead. */
export async function renameTag(db: Db, actor: string, input: { from: string; to: string }): Promise<{ companies_updated: number }> {
  const from = cleanTag(input.from, 'from')
  const to = cleanTag(input.to, 'to')
  if (from === to) throw new TagError('from and to are the same tag')
  return db.tx(async (q) => {
    const companies = await companiesWithTag(q, from)
    for (const c of companies) {
      const next = [...new Set(c.tags.filter((t) => t !== from).concat(to))]
      await q.query(`update lp.companies set tags = $1 where id = $2`, [next, c.id])
      await emitLeadEvent(q, { type: 'tag_removed', company_id: c.id, source: 'ops_api', actor, props: { tag: from, reason: 'rename' } })
      await emitLeadEvent(q, { type: 'tag_added', company_id: c.id, source: 'ops_api', actor, props: { tag: to, reason: 'rename' } })
    }
    const { rows: defRows } = await q.query<{ colour: string | null; description: string | null }>(`select colour, description from lp.tag_defs where tag = $1`, [from])
    if (defRows[0]) {
      await q.query(
        `insert into lp.tag_defs (tag, colour, description, created_by) values ($1,$2,$3,$4)
         on conflict (tag) do update set colour = coalesce(lp.tag_defs.colour, excluded.colour), description = coalesce(lp.tag_defs.description, excluded.description)`,
        [to, defRows[0].colour, defRows[0].description, actor],
      )
      await q.query(`delete from lp.tag_defs where tag = $1`, [from])
    } else {
      await q.query(`insert into lp.tag_defs (tag, created_by) values ($1,$2) on conflict (tag) do nothing`, [to, actor])
    }
    await writeTagHistory(q, from, 'rename', from, to, actor, `renamed "${from}" to "${to}" across ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`)
    return { companies_updated: companies.length }
  }, actor)
}

/** Merge several tags into one target tag across every company that carries any of them. */
export async function mergeTags(db: Db, actor: string, input: { tags: string[]; into: string }): Promise<{ companies_updated: number }> {
  const into = cleanTag(input.into, 'into')
  const sources = [...new Set((input.tags ?? []).map((t) => cleanTag(t)))].filter((t) => t !== into)
  if (!sources.length) throw new TagError('tags must list at least one tag other than "into"')
  return db.tx(async (q) => {
    const { rows: companies } = await q.query<{ id: number; tags: string[] }>(`select id, tags from lp.companies where tags && $1::text[]`, [sources])
    for (const c of companies) {
      const hadInto = c.tags.includes(into)
      const removed = sources.filter((s) => c.tags.includes(s))
      const next = [...new Set(c.tags.filter((t) => !sources.includes(t)).concat(into))]
      await q.query(`update lp.companies set tags = $1 where id = $2`, [next, c.id])
      for (const s of removed) await emitLeadEvent(q, { type: 'tag_removed', company_id: c.id, source: 'ops_api', actor, props: { tag: s, reason: 'merge' } })
      if (!hadInto) await emitLeadEvent(q, { type: 'tag_added', company_id: c.id, source: 'ops_api', actor, props: { tag: into, reason: 'merge' } })
    }
    await q.query(`insert into lp.tag_defs (tag, created_by) values ($1,$2) on conflict (tag) do nothing`, [into, actor])
    await q.query(`delete from lp.tag_defs where tag = any($1::text[])`, [sources])
    await writeTagHistory(q, into, 'merge', sources.join(', '), into, actor, `merged ${sources.map((s) => `"${s}"`).join(', ')} into "${into}" across ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`)
    return { companies_updated: companies.length }
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
