/**
 * "Owner research exhausted": a stored per-company fact (date + who) that the
 * search for the owner's own email found nothing more. Once set, the store's
 * role inbox (role-based-hold) scores Ready-generic and is sent only in its own
 * role-inbox batches. Clearing it puts the inbox back on hold. Both are logged
 * (activity log + the lead's history). Nothing is sent by this.
 */
import type { Db } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { RulesError } from './schema.ts'

export async function setOwnerResearchExhausted(db: Db, actor: string, companyId: number, exhausted: boolean, note: string | null) {
  return db.tx(async (q) => {
    const a = await q.query<{ display_name: string }>('select display_name from lp.actors where id = $1', [actor])
    if (!a.rows[0]) throw new RulesError(`Unknown actor ${actor}.`, 403)
    const cur = await q.query<{ name: string; owner_research_exhausted_at: Date | null }>(
      'select name, owner_research_exhausted_at from lp.companies where id = $1 for update',
      [companyId],
    )
    const co = cur.rows[0]
    if (!co) throw new RulesError('No lead with that id.', 404)
    const was = Boolean(co.owner_research_exhausted_at)
    if (was === exhausted) return { changed: false, exhausted }
    const cleanNote = note ? note.trim().slice(0, 500) || null : null
    await q.query(
      exhausted
        ? `update lp.companies set owner_research_exhausted_at = now(), owner_research_exhausted_by = $2, owner_research_note = $3 where id = $1`
        : `update lp.companies set owner_research_exhausted_at = null, owner_research_exhausted_by = null, owner_research_note = $3 where id = $1`,
      [companyId, actor, cleanNote],
    )
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by) values ('company', $1, 'owner_research_exhausted', $2, $3, $4)`,
      [companyId, was ? 'yes' : 'no', exhausted ? 'yes' : 'no', actor],
    )
    await logEvent(q, {
      actor,
      kind: exhausted ? 'lead.owner_research_exhausted' : 'lead.owner_research_reopened',
      summary: exhausted
        ? `${a.rows[0].display_name} marked owner research exhausted for ${co.name}: its role inbox can go out in role-inbox batches${cleanNote ? ` (“${cleanNote}”)` : ''}`
        : `${a.rows[0].display_name} reopened owner research for ${co.name}: its role inbox is back on hold`,
      entity_type: 'company',
      entity_id: companyId,
      data: { field: 'owner_research_exhausted', old: was, new: exhausted, note: cleanNote },
    })
    return { changed: true, exhausted }
  }, actor)
}
