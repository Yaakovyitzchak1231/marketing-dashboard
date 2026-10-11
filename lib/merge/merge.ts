/**
 * Merge (plan 1.9): collapse one company (or contact) into another in a single
 * transaction. Moves every dependent row to the kept id, applies the human's
 * field-by-field choices, soft-deletes the loser (merged_into), and writes
 * lp.merge_log + lp.status_history. Rejects a self-merge or merging an id that
 * is already a merge loser (or already merged into something else).
 */
import type { Db, Queryable } from '../db/types'

export class MergeError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export type MergeEntity = 'company' | 'contact'

const COMPANY_FIELDS = ['name', 'segment', 'vertical', 'website', 'phone', 'address_line', 'city', 'state', 'postal_code', 'owner_name', 'notes'] as const
const CONTACT_FIELDS = ['email', 'first_name', 'last_name', 'title', 'phone', 'personalization'] as const

async function requireRow(q: Queryable, table: 'companies' | 'contacts', id: number): Promise<Record<string, unknown>> {
  const { rows } = await q.query(`select * from lp.${table} where id = $1`, [id])
  if (!rows[0]) throw new MergeError(`${table === 'companies' ? 'Company' : 'Contact'} ${id} not found`, 404)
  return rows[0] as Record<string, unknown>
}

export interface MergeInput {
  entity: MergeEntity
  keep: number
  merge: number
  /** field -> 'keep' | 'merge' | an explicit replacement value. Unlisted fields default to 'keep'. */
  choices?: Record<string, unknown>
}

export interface MergeResult {
  entity: MergeEntity
  kept_id: number
  merged_id: number
  fields_applied: Record<string, unknown>
}

function resolveField(field: string, keepVal: unknown, mergeVal: unknown, choice: unknown): unknown {
  if (choice === undefined || choice === 'keep') return keepVal ?? mergeVal ?? null // keep empty fields fall back to the merged row's value
  if (choice === 'merge') return mergeVal ?? keepVal ?? null
  return choice // an explicit value the human typed in the compare UI
}

/** Move rows referencing `from` over to `to`, skipping any that would collide with a unique index already satisfied by `to`. */
async function moveNoDupe(
  q: Queryable,
  table: string,
  fkColumn: string,
  from: number,
  to: number,
  dupeCheck: string, // SQL fragment comparing aliased x (candidate row being moved) to y (an existing row already on `to`)
): Promise<void> {
  await q.query(
    `delete from lp.${table} x using lp.${table} y where x.${fkColumn} = $1 and y.${fkColumn} = $2 and (${dupeCheck})`,
    [from, to],
  )
  await q.query(`update lp.${table} set ${fkColumn} = $2 where ${fkColumn} = $1`, [from, to])
}

async function mergeCompanies(db: Db, actor: string, keep: number, merge: number, choices: Record<string, unknown>): Promise<MergeResult> {
  return db.tx(async (q) => {
    if (keep === merge) throw new MergeError('Cannot merge a company into itself')
    const keepRow = await requireRow(q, 'companies', keep)
    const mergeRow = await requireRow(q, 'companies', merge)
    if (keepRow.merged_into != null) throw new MergeError(`Company ${keep} is itself already merged into ${keepRow.merged_into}; pick the surviving row`, 409)
    if (mergeRow.merged_into != null) throw new MergeError(`Company ${merge} was already merged into ${mergeRow.merged_into}`, 409)

    const fieldsApplied: Record<string, unknown> = {}
    for (const f of COMPANY_FIELDS) fieldsApplied[f] = resolveField(f, keepRow[f], mergeRow[f], choices[f])
    await q.query(
      `update lp.companies set name=$1, segment=$2, vertical=$3, website=$4, phone=$5, address_line=$6, city=$7, state=$8, postal_code=$9, owner_name=$10, notes=$11, updated_at=now()
         where id = $12`,
      [fieldsApplied.name, fieldsApplied.segment, fieldsApplied.vertical, fieldsApplied.website, fieldsApplied.phone, fieldsApplied.address_line,
       fieldsApplied.city, fieldsApplied.state, fieldsApplied.postal_code, fieldsApplied.owner_name, fieldsApplied.notes, keep],
    )

    // Contacts: no unique conflict possible on company_id alone, just reassign.
    await q.query(`update lp.contacts set company_id = $2 where company_id = $1`, [merge, keep])
    // campaign_touches: company_id has no unique index.
    await q.query(`update lp.campaign_touches set company_id = $2 where company_id = $1`, [merge, keep])
    // sources: unique on (company_id, coalesce(contact_id,0), kind, source_ref) -- drop exact dupes, move the rest.
    await moveNoDupe(q, 'sources', 'company_id', merge, keep, `x.kind = y.kind and x.source_ref = y.source_ref and coalesce(x.contact_id,0) = coalesce(y.contact_id,0)`)
    // enrichment: unique on (company_id, field, lower(value)) -- drop exact dupes, move the rest.
    await moveNoDupe(q, 'enrichment', 'company_id', merge, keep, `x.field = y.field and lower(x.value) = lower(y.value)`)
    // tasks / comments: company-scoped, no unique conflict.
    await q.query(`update lp.tasks set company_id = $2 where company_id = $1`, [merge, keep])
    await q.query(`update lp.comments set company_id = $2 where company_id = $1`, [merge, keep])

    await q.query(`update lp.companies set merged_into = $1, updated_at = now() where id = $2`, [keep, merge])
    await q.query(
      `insert into lp.merge_log (entity, kept_id, merged_id, field_choices, actor) values ('company', $1, $2, $3, $4)`,
      [keep, merge, JSON.stringify(choices), actor],
    )
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
         values ('company', $1, 'merge', null, $2, $3, 'ui', $4)`,
      [keep, String(merge), actor, `Merged company #${merge} (${String(mergeRow.name ?? '')}) into this one`],
    )
    return { entity: 'company' as const, kept_id: keep, merged_id: merge, fields_applied: fieldsApplied }
  }, actor)
}

async function mergeContacts(db: Db, actor: string, keep: number, merge: number, choices: Record<string, unknown>): Promise<MergeResult> {
  return db.tx(async (q) => {
    if (keep === merge) throw new MergeError('Cannot merge a contact into itself')
    const keepRow = await requireRow(q, 'contacts', keep)
    const mergeRow = await requireRow(q, 'contacts', merge)
    if (keepRow.merged_into != null) throw new MergeError(`Contact ${keep} is itself already merged into ${keepRow.merged_into}; pick the surviving row`, 409)
    if (mergeRow.merged_into != null) throw new MergeError(`Contact ${merge} was already merged into ${mergeRow.merged_into}`, 409)

    const fieldsApplied: Record<string, unknown> = {}
    for (const f of CONTACT_FIELDS) fieldsApplied[f] = resolveField(f, keepRow[f], mergeRow[f], choices[f])
    await q.query(
      `update lp.contacts set email=$1, email_norm=lower($1), first_name=$2, last_name=$3, title=$4, phone=$5, personalization=$6, updated_at=now()
         where id = $7`,
      [fieldsApplied.email, fieldsApplied.first_name, fieldsApplied.last_name, fieldsApplied.title, fieldsApplied.phone, fieldsApplied.personalization, keep],
    )
    await q.query(`update lp.verification_results set contact_id = $2 where contact_id = $1`, [merge, keep])
    await q.query(`update lp.campaign_touches set contact_id = $2 where contact_id = $1`, [merge, keep])
    await moveNoDupe(q, 'sources', 'contact_id', merge, keep, `x.kind = y.kind and x.source_ref = y.source_ref and coalesce(x.company_id,0) = coalesce(y.company_id,0)`)
    await q.query(`update lp.enrichment set contact_id = $2 where contact_id = $1`, [merge, keep])

    await q.query(`update lp.contacts set merged_into = $1, email_norm = null, updated_at = now() where id = $2`, [keep, merge])
    await q.query(
      `insert into lp.merge_log (entity, kept_id, merged_id, field_choices, actor) values ('contact', $1, $2, $3, $4)`,
      [keep, merge, JSON.stringify(choices), actor],
    )
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
         values ('contact', $1, 'merge', null, $2, $3, 'ui', $4)`,
      [keep, String(merge), actor, `Merged contact #${merge} into this one`],
    )
    return { entity: 'contact' as const, kept_id: keep, merged_id: merge, fields_applied: fieldsApplied }
  }, actor)
}

export async function merge(db: Db, actor: string, input: MergeInput): Promise<MergeResult> {
  const keep = Number(input.keep)
  const mergeId = Number(input.merge)
  if (!Number.isInteger(keep) || keep <= 0 || !Number.isInteger(mergeId) || mergeId <= 0) throw new MergeError('keep and merge must both be positive ids')
  const choices = input.choices ?? {}
  return input.entity === 'company' ? mergeCompanies(db, actor, keep, mergeId, choices) : mergeContacts(db, actor, keep, mergeId, choices)
}
