/**
 * Reading the universal audit log (lp.status_history), newest first, with the
 * actor's display name joined in — what the History drawer (components/edit/
 * HistoryDrawer.tsx) and the `entity_history` / `recent_changes` ops read.
 */
import type { Queryable } from '../db/types'
import { RegistryError } from './registry'
import { actorName } from '../leads/queries'

export interface HistoryRow {
  id: number
  entity_type: string
  entity_id: number
  field: string
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_by_name: string
  via: string | null
  note: string | null
  changed_at: string
}

function parseCampaignLeadId(id: string | number): { campaignId: number; companyId: number } {
  const m = /^(\d+):(\d+)$/.exec(String(id))
  if (!m) throw new RegistryError('A campaign_lead id must look like "<campaign_id>:<company_id>".')
  return { campaignId: Number(m[1]), companyId: Number(m[2]) }
}

async function withNames(q: Queryable, rows: Omit<HistoryRow, 'changed_by_name'>[]): Promise<HistoryRow[]> {
  const names = new Map<string, string>()
  for (const r of rows) {
    if (r.changed_by && !names.has(r.changed_by)) names.set(r.changed_by, await actorName(q, r.changed_by))
  }
  return rows.map((r) => ({ ...r, changed_by_name: r.changed_by ? (names.get(r.changed_by) ?? r.changed_by) : 'system' }))
}

/** One entity's history, newest first. `before` (a status_history row id) pages further back. */
export async function entityHistory(
  db: Queryable,
  type: string,
  id: string | number,
  opts: { limit?: number; before?: number } = {},
): Promise<HistoryRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  if (type === 'campaign_lead') {
    const { campaignId, companyId } = parseCampaignLeadId(id)
    const { rows } = await db.query<Omit<HistoryRow, 'changed_by_name'>>(
      `select id, entity_type, entity_id, field, old_value, new_value, changed_by, via, note, changed_at::text as changed_at
         from lp.status_history
        where entity_type = 'campaign_lead' and entity_id = $1 and note like $2
          and ($3::bigint is null or id < $3)
        order by id desc limit $4`,
      [companyId, `campaign ${campaignId}%`, opts.before ?? null, limit],
    )
    return withNames(db, rows)
  }
  const entityId = Number(id)
  if (!Number.isInteger(entityId) || entityId <= 0) throw new RegistryError('id must be a positive integer id.')
  const { rows } = await db.query<Omit<HistoryRow, 'changed_by_name'>>(
    `select id, entity_type, entity_id, field, old_value, new_value, changed_by, via, note, changed_at::text as changed_at
       from lp.status_history
      where entity_type = $1 and entity_id = $2 and ($3::bigint is null or id < $3)
      order by id desc limit $4`,
    [type, entityId, opts.before ?? null, limit],
  )
  return withNames(db, rows)
}

/** Across every entity (or narrowed by actor/type) — "what changed lately", newest first. */
export async function recentChanges(
  db: Queryable,
  opts: { actor?: string; type?: string; limit?: number } = {},
): Promise<HistoryRow[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  const { rows } = await db.query<Omit<HistoryRow, 'changed_by_name'>>(
    `select id, entity_type, entity_id, field, old_value, new_value, changed_by, via, note, changed_at::text as changed_at
       from lp.status_history
      where ($1::text is null or changed_by = $1) and ($2::text is null or entity_type = $2)
      order by id desc limit $3`,
    [opts.actor ?? null, opts.type ?? null, limit],
  )
  return withNames(db, rows)
}
