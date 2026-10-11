/**
 * Merge (plan 1.9): collapse one company (or contact) into another in a single
 * transaction. Moves every dependent row to the kept id, applies the human's
 * field-by-field choices, soft-deletes the loser (merged_into), and writes
 * lp.merge_log + lp.status_history. Rejects a self-merge or merging an id that
 * is already a merge loser (or already merged into something else).
 */
import type { Db, Queryable } from '../db/types'
import { nameAddressKey, normalizeDomain, normalizeEmail, normalizePhone } from '../leads/normalize'

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

/** Re-point a plain FK column (no unique index involving it) from `from` to `to`. */
async function movePlain(q: Queryable, table: string, fkColumn: string, from: number, to: number): Promise<void> {
  await q.query(`update lp.${table} set ${fkColumn} = $2 where ${fkColumn} = $1`, [from, to])
}

/** lp.lead_events is append-only; migration 0036 lets a merge (flag lp.merge, this transaction only) re-point its ids. */
async function moveLeadEvents(q: Queryable, fkColumn: 'company_id' | 'contact_id', from: number, to: number): Promise<void> {
  await q.query(`select set_config('lp.merge', 'on', true)`)
  await q.query(`update lp.lead_events set ${fkColumn} = $2 where ${fkColumn} = $1`, [from, to])
  await q.query(`select set_config('lp.merge', 'off', true)`)
}

/** A dedupe key for the survivor: the candidates in order, skipping any another LIVE company already owns. */
async function freeCompanyKey(q: Queryable, column: 'website_domain' | 'phone_e164' | 'name_addr_key', keep: number, candidates: (string | null | undefined)[]): Promise<string | null> {
  for (const c of candidates) {
    if (!c) continue
    const { rows } = await q.query(`select 1 from lp.companies where ${column} = $1 and id <> $2 and merged_into is null limit 1`, [c, keep])
    if (!rows.length) return c
  }
  return null
}

const SUB_RANK: Record<string, number> = { never_asked: 0, subscribed: 1, bounced: 2, unsubscribed: 3 }

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

    // Campaign membership, rule evaluations, the timeline, engine items, lists, scores,
    // traits and files follow the survivor (the dead row must not keep any of them).
    await moveNoDupe(q, 'campaign_leads', 'company_id', merge, keep, `x.campaign_id = y.campaign_id`)
    await moveNoDupe(q, 'lead_evaluations', 'company_id', merge, keep, `x.rule_set_id = y.rule_set_id`)
    await moveLeadEvents(q, 'company_id', merge, keep)
    await movePlain(q, 'engine_items', 'company_id', merge, keep)
    await moveNoDupe(q, 'segment_members', 'company_id', merge, keep, `x.segment_id = y.segment_id and x.company_id is not null and y.company_id is not null`)
    await moveNoDupe(q, 'scores', 'company_id', merge, keep, `x.model_id = y.model_id and x.contact_id is null and y.contact_id is null`)
    await movePlain(q, 'score_points', 'company_id', merge, keep)
    await movePlain(q, 'score_history', 'company_id', merge, keep)
    await moveNoDupe(q, 'trait_values', 'company_id', merge, keep, `x.trait_key = y.trait_key and x.contact_id is null and y.contact_id is null`)
    await movePlain(q, 'files', 'company_id', merge, keep)
    await q.query(
      `update lp.companies k set tags = coalesce((select array_agg(distinct t) from unnest(k.tags || m.tags) t), '{}'),
              custom = m.custom || k.custom
         from lp.companies m where k.id = $1 and m.id = $2`,
      [keep, merge],
    )

    // Hide the loser FIRST (the live-row unique indexes skip merged rows), then give the
    // survivor its dedupe keys, so later imports match the survivor, never the hidden row.
    await q.query(`update lp.companies set merged_into = $1, updated_at = now() where id = $2`, [keep, merge])
    const domain = await freeCompanyKey(q, 'website_domain', keep, [normalizeDomain(fieldsApplied.website as string | null), keepRow.website_domain as string | null, mergeRow.website_domain as string | null])
    const phone = await freeCompanyKey(q, 'phone_e164', keep, [normalizePhone(fieldsApplied.phone as string | null), keepRow.phone_e164 as string | null, mergeRow.phone_e164 as string | null])
    const nak = await freeCompanyKey(q, 'name_addr_key', keep, [
      nameAddressKey(fieldsApplied.name as string | null, fieldsApplied.address_line as string | null, fieldsApplied.city as string | null, fieldsApplied.state as string | null),
      keepRow.name_addr_key as string | null, mergeRow.name_addr_key as string | null,
    ])
    await q.query(`update lp.companies set website_domain = $2, phone_e164 = $3, name_addr_key = $4 where id = $1`, [keep, domain, phone, nak])
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
    // Hide the loser FIRST: its email_norm must be gone before the survivor takes the
    // chosen email, or the live-row unique index (contacts_email_uq) rejects the update.
    await q.query(`update lp.contacts set merged_into = $1, email_norm = null, updated_at = now() where id = $2`, [keep, merge])
    // The survivor keeps the strictest consent state of the two: an unsubscribe or bounce on
    // either row keeps protecting the merged person.
    const keepSub = String(keepRow.subscription_status ?? 'never_asked')
    const mergeSub = String(mergeRow.subscription_status ?? 'never_asked')
    const subscription = (SUB_RANK[mergeSub] ?? 0) > (SUB_RANK[keepSub] ?? 0) ? mergeSub : keepSub
    const doNotContact = Boolean(keepRow.do_not_contact) || Boolean(mergeRow.do_not_contact)
    await q.query(
      `update lp.contacts set email=$1, email_norm=$2, first_name=$3, last_name=$4, title=$5, phone=$6, phone_e164=$7, personalization=$8,
              subscription_status=$9, do_not_contact=$10, status = case when $10 then 'do-not-contact' else status end,
              custom = (select m.custom from lp.contacts m where m.id = $12) || custom, updated_at=now()
         where id = $11`,
      [fieldsApplied.email, normalizeEmail(fieldsApplied.email as string | null), fieldsApplied.first_name, fieldsApplied.last_name, fieldsApplied.title,
       fieldsApplied.phone, normalizePhone(fieldsApplied.phone as string | null) ?? (keepRow.phone_e164 as string | null) ?? (mergeRow.phone_e164 as string | null),
       fieldsApplied.personalization, subscription, doNotContact, keep, merge],
    )
    // Live suppressions on the merged-away address also protect the survivor's address.
    const keepNorm = normalizeEmail(fieldsApplied.email as string | null)
    const mergeNorm = normalizeEmail(mergeRow.email as string | null)
    if (keepNorm && mergeNorm && keepNorm !== mergeNorm) {
      await q.query(
        `insert into lp.suppressions (email_norm, campaign_id, reason, source, note, created_by)
         select $1, s.campaign_id, s.reason, 'merge', 'Carried over when contact #' || $3::text || ' was merged into this one', $4
           from lp.suppressions s
          where s.email_norm = $2 and s.lifted_at is null and (s.expires_at is null or s.expires_at > now())
         on conflict do nothing`,
        [keepNorm, mergeNorm, String(merge), actor],
      )
    }
    await q.query(`update lp.verification_results set contact_id = $2 where contact_id = $1`, [merge, keep])
    await q.query(`update lp.campaign_touches set contact_id = $2 where contact_id = $1`, [merge, keep])
    await moveNoDupe(q, 'sources', 'contact_id', merge, keep, `x.kind = y.kind and x.source_ref = y.source_ref and coalesce(x.company_id,0) = coalesce(y.company_id,0)`)
    await q.query(`update lp.enrichment set contact_id = $2 where contact_id = $1`, [merge, keep])
    // Consent history, campaign membership, evaluations, the timeline, lists, scores, traits, files.
    await movePlain(q, 'consent_log', 'contact_id', merge, keep)
    await movePlain(q, 'campaign_leads', 'contact_id', merge, keep)
    await movePlain(q, 'lead_evaluations', 'contact_id', merge, keep)
    await moveLeadEvents(q, 'contact_id', merge, keep)
    await moveNoDupe(q, 'segment_members', 'contact_id', merge, keep, `x.segment_id = y.segment_id and x.contact_id is not null and y.contact_id is not null`)
    await moveNoDupe(q, 'scores', 'contact_id', merge, keep, `x.model_id = y.model_id`)
    await movePlain(q, 'score_points', 'contact_id', merge, keep)
    await movePlain(q, 'score_history', 'contact_id', merge, keep)
    await moveNoDupe(q, 'trait_values', 'contact_id', merge, keep, `x.trait_key = y.trait_key`)
    await movePlain(q, 'files', 'contact_id', merge, keep)
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
