/**
 * The universal inline-edit writer (plan item 1.3): updateEntity validates one
 * field against lib/edit/registry.ts, no-ops when the value hasn't changed,
 * writes the field, and inserts ONE lp.status_history row per changed field —
 * except for company.stage and contact.status/verification_status, which
 * already have a DB trigger writing that row (see registry.ts); writing it
 * again here would double-log them.
 *
 * company and contact delegate to lib/leads/edit.ts's editCompany/editContact
 * (the existing #45 lead-edit code — normalization, dup checks, the email
 * verification-reset rule, and its own status_history write already live
 * there). campaign, campaign_lead and task are new direct-column writers.
 */
import type { Db, Queryable } from '../db/types'
import { fieldDef, RegistryError, type CompanyPatch, type ContactPatch, type EntityType } from './registry'
import { editCompany, editContact, LeadEditError } from '../leads/edit'
import { guardCampaignEdit } from '../campaigns/store'
import { CampaignError, type CampaignPatch } from '../campaigns/types'
import { writeCustomFieldValue } from '../fields/store'
import { safeOnFieldChanged } from '../triggers/match'

/** The registry's normalized text value -> the typed value updateCampaign's own checks expect. */
function campaignPatchFor(field: string, next: string | null): CampaignPatch {
  if (field === 'rule_set_id') return { rule_set_id: next == null ? null : Number(next) }
  if (field === 'is_template') return { is_template: next === 'true' }
  return { [field]: next } as CampaignPatch
}

export type Via = 'ui' | 'ops_api'

export interface UpdateEntityInput {
  type: string
  id: string | number
  field: string
  value: unknown
  via?: Via
  note?: string | null
}

export interface UpdateEntityResult {
  changed: boolean
  field: string
  from: string | null
  to: string | null
}

function noteOf(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null
  const s = String(note).trim()
  if (!s) return null
  if (s.length > 1000) throw new RegistryError('note is too long (max 1000 characters).')
  return s
}

/** campaign_lead has a composite key; the one `id` argument is "<campaignId>:<companyId>". */
function parseCampaignLeadId(id: string | number): { campaignId: number; companyId: number } {
  const s = String(id)
  const m = /^(\d+):(\d+)$/.exec(s)
  if (!m) throw new RegistryError('A campaign_lead id must look like "<campaign_id>:<company_id>".')
  return { campaignId: Number(m[1]), companyId: Number(m[2]) }
}

function positiveInt(id: string | number, what: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new RegistryError(`${what} must be a positive integer id.`)
  return n
}

async function writeHistoryRow(
  q: Queryable,
  entity_type: EntityType,
  entity_id: number,
  field: string,
  from: string | null,
  to: string | null,
  actor: string,
  via: Via,
  note: string | null,
) {
  await q.query(
    `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entity_type, entity_id, field, from, to, actor, via, note],
  )
}

/** A plain column update on one row, keyed by one or more equality columns, with a status_history
 *  row unless the field's own DB trigger already writes it. `field` is only ever a value already
 *  checked against the registry's whitelist by the time this runs, so interpolating it is safe. */
async function directUpdate(
  q: Queryable,
  entityType: EntityType,
  table: string,
  keyCols: { col: string; val: unknown }[],
  field: string,
  nextValue: string | null,
  historyEntityId: number,
  actor: string,
  via: Via,
  note: string | null,
  trigger: boolean,
): Promise<UpdateEntityResult> {
  const selWhere = keyCols.map((k, i) => `${k.col} = $${i + 1}`).join(' and ')
  const { rows } = await q.query<Record<string, unknown>>(`select ${field} from ${table} where ${selWhere} for update`, keyCols.map((k) => k.val))
  if (!rows[0]) throw new RegistryError(`No ${entityType} found for that id.`, 404)
  const cur = rows[0][field]
  const curText = cur === null || cur === undefined ? null : String(cur)
  if (curText === nextValue) return { changed: false, field, from: curText, to: nextValue }
  const updWhere = keyCols.map((k, i) => `${k.col} = $${i + 2}`).join(' and ')
  try {
    await q.query(`update ${table} set ${field} = $1 where ${updWhere}`, [nextValue, ...keyCols.map((k) => k.val)])
  } catch (e) {
    // Postgres 23503: foreign_key_violation. campaign.pool (and any other FK-backed field here)
    // takes any slug syntactically (registry.ts); the DB is what knows which pools actually exist.
    if ((e as { code?: string }).code === '23503') throw new RegistryError(`Unknown ${field}.`, 400)
    throw e
  }
  if (!trigger) await writeHistoryRow(q, entityType, historyEntityId, field, curText, nextValue, actor, via, note)
  if (entityType === 'company' || entityType === 'contact') {
    const companyId = entityType === 'company'
      ? historyEntityId
      : (await q.query<{ company_id: number | null }>('select company_id from lp.contacts where id = $1', [historyEntityId])).rows[0]?.company_id ?? null
    await safeOnFieldChanged(q, {
      entity: entityType,
      id: historyEntityId,
      field,
      from: curText,
      to: nextValue,
      company_id: companyId,
      contact_id: entityType === 'contact' ? historyEntityId : null,
    })
  }
  return { changed: true, field, from: curText, to: nextValue }
}

/** Update one field on one entity. Validates, no-ops when unchanged, writes the field, logs one
 *  status_history row (unless a DB trigger already owns that field). Runs inside its own transaction. */
export async function updateEntity(db: Db, actor: string, input: UpdateEntityInput): Promise<UpdateEntityResult> {
  // Custom fields (plan 1.7): "custom.<key>" writes into companies.custom /
  // contacts.custom, validated against lp.field_defs -- the dynamic part of the
  // registry that the static table below can't express.
  if (input.field.startsWith('custom.')) {
    if (input.type !== 'company' && input.type !== 'contact') throw new RegistryError('Custom fields are only on company or contact.')
    const entityId = positiveInt(input.id, `${input.type} id`)
    const r = await writeCustomFieldValue(db, actor, {
      entityType: input.type,
      entityId,
      key: input.field.slice('custom.'.length),
      value: input.value,
      via: input.via ?? 'ops_api',
      note: noteOf(input.note),
    })
    return r
  }
  const type = input.type as EntityType
  const def = fieldDef(input.type, input.field)
  const next = def.validate(input.value)
  const via: Via = input.via ?? 'ops_api'
  const note = noteOf(input.note)

  if (def.writer.kind === 'lead_edit') {
    if (type === 'contact') {
      const contactId = positiveInt(input.id, 'contact id')
      const found = await db.query<{ company_id: number }>('select company_id from lp.contacts where id = $1', [contactId])
      if (!found.rows[0]) throw new RegistryError('No contact found for that id.', 404)
      const patch = { [input.field]: next } as unknown as ContactPatch
      const r = await editContact(db, found.rows[0].company_id, contactId, patch, actor, { via, note })
      const c = r.changes.find((x) => x.field === input.field)
      return c ? { changed: true, field: input.field, from: c.from, to: c.to } : { changed: false, field: input.field, from: null, to: next }
    }
    // company
    const companyId = positiveInt(input.id, 'company id')
    const patch = { [input.field]: next } as unknown as CompanyPatch
    const r = await editCompany(db, companyId, patch, actor, { via, note })
    const c = r.changes.find((x) => x.field === input.field)
    return c ? { changed: true, field: input.field, from: c.from, to: c.to } : { changed: false, field: input.field, from: null, to: next }
  }

  // direct writers: campaign, campaign_lead, task, and company.stage (the one direct field on company)
  const w = def.writer
  return db.tx(async (q) => {
    if (type === 'campaign') {
      const id = positiveInt(input.id, 'campaign id')
      try {
        await guardCampaignEdit(q, actor, id, campaignPatchFor(input.field, next))
      } catch (e) {
        if (e instanceof CampaignError) throw new RegistryError(e.message, e.status)
        throw e
      }
      return directUpdate(q, 'campaign', w.table, [{ col: 'id', val: id }], input.field, next, id, actor, via, note, w.trigger === true)
    }
    if (type === 'campaign_lead') {
      const { campaignId, companyId } = parseCampaignLeadId(input.id)
      const campaignNote = note ? `campaign ${campaignId}: ${note}` : `campaign ${campaignId}`
      return directUpdate(
        q, 'campaign_lead', w.table, [{ col: 'campaign_id', val: campaignId }, { col: 'company_id', val: companyId }],
        input.field, next, companyId, actor, via, campaignNote, false,
      )
    }
    if (type === 'task') {
      const id = positiveInt(input.id, 'task id')
      return directUpdate(q, 'task', w.table, [{ col: 'id', val: id }], input.field, next, id, actor, via, note, false)
    }
    // company.stage
    const id = positiveInt(input.id, 'company id')
    return directUpdate(q, 'company', w.table, [{ col: 'id', val: id }], input.field, next, id, actor, via, note, w.trigger === true)
  }, actor)
}

export interface UpdateEntityFieldsInput {
  type: string
  id: string | number
  fields: Record<string, unknown>
  via?: Via
  note?: string | null
}

/** Several fields on one entity, one call. Each field goes through updateEntity's same validation
 *  and no-op check; results come back per field so the caller can show which actually changed. */
export async function updateEntityFields(db: Db, actor: string, input: UpdateEntityFieldsInput): Promise<UpdateEntityResult[]> {
  const entries = Object.entries(input.fields ?? {})
  if (!entries.length) throw new RegistryError('No fields to change.')
  const out: UpdateEntityResult[] = []
  for (const [field, value] of entries) {
    out.push(await updateEntity(db, actor, { type: input.type, id: input.id, field, value, via: input.via, note: input.note }))
  }
  return out
}

export { RegistryError, LeadEditError }
