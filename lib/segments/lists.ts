/**
 * Static lists (plan 2.4), the UI layer over the segment engine's static
 * segments (lib/segments/store.ts, ops.ts): "Add to list..." from the Leads
 * bulk bar, and the Lists card on a lead's page. A list IS a kind='static'
 * lp.segments row; membership reuses the already-tested segment_add_members /
 * segment_remove_members ops (lib/ops/dispatch.ts) instead of re-implementing
 * the insert + lead-event logic here.
 */
import type { Db, Queryable } from '../db/types.ts'
import { getSegment, listSegments, type Segment } from './store.ts'
import { runOp } from '../ops/dispatch.ts'

/** Every static, company-entity, non-archived list -- the picker's options. */
export async function listStaticLists(q: Queryable): Promise<Segment[]> {
  const all = await listSegments(q, { includeArchived: false })
  return all.filter((s) => s.kind === 'static' && s.entity === 'company')
}

/** The lists a lead (company) belongs to, for the Lists card. */
export async function companyLists(q: Queryable, companyId: number): Promise<{ id: number; name: string }[]> {
  const { rows } = await q.query<{ id: number; name: string }>(
    `select s.id, s.name from lp.segment_members sm join lp.segments s on s.id = sm.segment_id
      where sm.company_id = $1 and s.kind = 'static' and s.archived_at is null order by s.name`,
    [companyId],
  )
  return rows.map((r) => ({ id: Number(r.id), name: r.name }))
}

export class ListsError extends Error {}

/** Add these leads to an existing list (list_id) or a brand-new one (new_list_name). */
export async function addCompaniesToList(
  db: Db,
  actor: string,
  opts: { listId?: number | null; newListName?: string | null },
  companyIds: number[],
): Promise<{ list: { id: number; name: string }; added: number }> {
  if (!companyIds.length) throw new ListsError('Select at least one lead.')
  let listId = opts.listId ?? null
  let listName: string
  if (listId) {
    const seg = await getSegment(db, listId)
    if (!seg || seg.kind !== 'static' || seg.entity !== 'company') throw new ListsError('Pick an existing list.')
    listName = seg.name
  } else {
    const name = (opts.newListName ?? '').trim()
    if (!name) throw new ListsError('Name the new list, or pick an existing one.')
    const created = (await runOp(db, actor, 'create_segment', {
      name,
      entity: 'company',
      kind: 'static',
      definition: { entity: 'company', include: [] },
    })) as { id: number; name: string }
    listId = created.id
    listName = created.name
  }
  const result = (await runOp(db, actor, 'segment_add_members', { id: listId, company_ids: companyIds })) as { added: number }
  return { list: { id: listId, name: listName }, added: result.added }
}

export async function removeCompanyFromList(db: Db, actor: string, listId: number, companyId: number): Promise<void> {
  await runOp(db, actor, 'segment_remove_members', { id: listId, company_ids: [companyId] })
}
