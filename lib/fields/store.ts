/**
 * Custom fields (plan item 1.7): define / update / archive a field, and write
 * one value into companies.custom / contacts.custom. Entity-type checks, slug
 * uniqueness, and the audit row (lp.status_history) live here; type validation
 * of a value lives in lib/fields/registry.ts (shared with anything that reads
 * a value, e.g. the segment engine later).
 */
import type { Db, Queryable } from '../db/types'
import { safeOnFieldChanged } from '../triggers/match'
import {
  FIELD_ENTITIES,
  FIELD_KEY_RE,
  FIELD_TYPES,
  FieldError,
  type FieldDefRow,
  type FieldEntity,
  type FieldType,
  fieldDefByKey,
  listFieldDefs,
  validateFieldValue,
} from './registry'

export { FieldError, listFieldDefs, type FieldDefRow, type FieldEntity, type FieldType } from './registry'

async function writeFieldDefHistory(
  q: Queryable,
  fieldId: number,
  field: string,
  from: string | null,
  to: string | null,
  actor: string,
  via: 'ui' | 'ops_api',
) {
  await q.query(
    `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via)
     values ('field_def', $1, $2, $3, $4, $5, $6)`,
    [fieldId, field, from, to, actor, via],
  )
}

function checkEntity(entity: unknown): FieldEntity {
  if (typeof entity !== 'string' || !(FIELD_ENTITIES as readonly string[]).includes(entity)) {
    throw new FieldError(`entity must be one of: ${FIELD_ENTITIES.join(', ')}.`)
  }
  return entity as FieldEntity
}

function checkType(type: unknown): FieldType {
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    throw new FieldError(`type must be one of: ${FIELD_TYPES.join(', ')}.`)
  }
  return type as FieldType
}

function checkOptions(type: FieldType, options: unknown): string[] {
  if (type !== 'select' && type !== 'multi_select') return []
  const list = options === undefined || options === null ? [] : options
  if (!Array.isArray(list) || list.some((o) => typeof o !== 'string')) {
    throw new FieldError('options must be an array of strings.')
  }
  const cleaned = Array.from(new Set(list.map((o) => String(o).trim()).filter(Boolean)))
  if (!cleaned.length) throw new FieldError(`A ${type === 'select' ? 'select' : 'multi-select'} field needs at least one option.`)
  return cleaned
}

export interface DefineFieldInput {
  entity: unknown
  key: unknown
  label: unknown
  type: unknown
  options?: unknown
  campaign_id?: unknown
  sort?: unknown
  via?: 'ui' | 'ops_api'
}

export async function defineField(db: Db, actor: string, input: DefineFieldInput): Promise<FieldDefRow> {
  const entity = checkEntity(input.entity)
  const key = typeof input.key === 'string' ? input.key.trim().toLowerCase() : ''
  if (!FIELD_KEY_RE.test(key)) throw new FieldError('key must be a lowercase slug (letters, digits, _; starts with a letter; max 63 chars).')
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (!label || label.length > 80) throw new FieldError('label is required (max 80 characters).')
  const type = checkType(input.type)
  const options = checkOptions(type, input.options)
  const campaignId = input.campaign_id == null || input.campaign_id === '' ? null : Number(input.campaign_id)
  if (campaignId !== null && (!Number.isInteger(campaignId) || campaignId <= 0)) throw new FieldError('campaign_id must be a positive integer, or empty for every campaign.')
  const sort = input.sort == null ? 100 : Number(input.sort)
  const via = input.via ?? 'ops_api'

  const existing = await fieldDefByKey(db, entity, key)
  if (existing) throw new FieldError(`"${key}" is already a field on ${entity}.`, 409)

  return db.tx(async (q) => {
    let row
    try {
      const { rows } = await q.query<Record<string, unknown>>(
        `insert into lp.field_defs (entity, key, label, type, options, campaign_id, sort, created_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning *`,
        [entity, key, label, type, JSON.stringify(options), campaignId, sort, actor],
      )
      row = rows[0]
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new FieldError('Unknown campaign_id.', 400)
      throw e
    }
    await writeFieldDefHistory(q, Number(row.id), 'defined', null, `${entity}.${key} (${type})`, actor, via)
    const defs = await listFieldDefs(q, { entity })
    return defs.find((d) => d.id === Number(row.id))!
  }, actor)
}

export interface UpdateFieldInput {
  id: unknown
  label?: unknown
  options?: unknown
  sort?: unknown
  campaign_id?: unknown
  via?: 'ui' | 'ops_api'
}

/** Rename, reorder, re-scope to a campaign, or change a select/multi-select's options.
 *  Type and key are permanent once created (existing stored values already assume them). */
export async function updateField(db: Db, actor: string, input: UpdateFieldInput): Promise<FieldDefRow> {
  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) throw new FieldError('id must be a positive integer.')
  const via = input.via ?? 'ops_api'
  return db.tx(async (q) => {
    const { rows } = await q.query<Record<string, unknown>>('select * from lp.field_defs where id = $1 for update', [id])
    const cur = rows[0]
    if (!cur) throw new FieldError('No field found for that id.', 404)
    if (cur.archived_at) throw new FieldError('That field is archived. Define a new one instead.', 409)

    if (input.label !== undefined) {
      const label = typeof input.label === 'string' ? input.label.trim() : ''
      if (!label || label.length > 80) throw new FieldError('label must be 1-80 characters.')
      if (label !== cur.label) {
        await q.query('update lp.field_defs set label = $1 where id = $2', [label, id])
        await writeFieldDefHistory(q, id, 'label', String(cur.label), label, actor, via)
        cur.label = label
      }
    }
    if (input.options !== undefined) {
      const options = checkOptions(cur.type as FieldType, input.options)
      const curOptions = Array.isArray(cur.options) ? cur.options : JSON.parse(String(cur.options ?? '[]'))
      if (JSON.stringify(options) !== JSON.stringify(curOptions)) {
        await q.query('update lp.field_defs set options = $1::jsonb where id = $2', [JSON.stringify(options), id])
        await writeFieldDefHistory(q, id, 'options', JSON.stringify(curOptions), JSON.stringify(options), actor, via)
      }
    }
    if (input.sort !== undefined) {
      const sort = Number(input.sort)
      if (!Number.isFinite(sort)) throw new FieldError('sort must be a number.')
      if (sort !== Number(cur.sort)) {
        await q.query('update lp.field_defs set sort = $1 where id = $2', [sort, id])
        await writeFieldDefHistory(q, id, 'sort', String(cur.sort), String(sort), actor, via)
      }
    }
    if (input.campaign_id !== undefined) {
      const campaignId = input.campaign_id == null || input.campaign_id === '' ? null : Number(input.campaign_id)
      if (campaignId !== null && (!Number.isInteger(campaignId) || campaignId <= 0)) throw new FieldError('campaign_id must be a positive integer, or empty for every campaign.')
      const curCampaignId = cur.campaign_id == null ? null : Number(cur.campaign_id)
      if (campaignId !== curCampaignId) {
        try {
          await q.query('update lp.field_defs set campaign_id = $1 where id = $2', [campaignId, id])
        } catch (e) {
          if ((e as { code?: string }).code === '23503') throw new FieldError('Unknown campaign_id.', 400)
          throw e
        }
        await writeFieldDefHistory(q, id, 'campaign_id', curCampaignId == null ? null : String(curCampaignId), campaignId == null ? null : String(campaignId), actor, via)
      }
    }
    const defs = await listFieldDefs(q, { entity: cur.entity as FieldEntity, include_archived: true })
    return defs.find((d) => d.id === id)!
  }, actor)
}

export interface ArchiveFieldInput {
  id: unknown
  via?: 'ui' | 'ops_api'
}

export async function archiveField(db: Db, actor: string, input: ArchiveFieldInput): Promise<FieldDefRow> {
  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) throw new FieldError('id must be a positive integer.')
  const via = input.via ?? 'ops_api'
  return db.tx(async (q) => {
    const { rows } = await q.query<Record<string, unknown>>('select * from lp.field_defs where id = $1 for update', [id])
    const cur = rows[0]
    if (!cur) throw new FieldError('No field found for that id.', 404)
    if (cur.archived_at) return (await listFieldDefs(q, { entity: cur.entity as FieldEntity, include_archived: true })).find((d) => d.id === id)!
    await q.query('update lp.field_defs set archived_at = now() where id = $1', [id])
    await writeFieldDefHistory(q, id, 'archived', null, `${cur.entity}.${cur.key}`, actor, via)
    return (await listFieldDefs(q, { entity: cur.entity as FieldEntity, include_archived: true })).find((d) => d.id === id)!
  }, actor)
}

export type Via = 'ui' | 'ops_api'

export interface WriteCustomFieldValueInput {
  entityType: 'company' | 'contact'
  entityId: number
  key: string
  value: unknown
  via: Via
  note: string | null
}

export interface WriteCustomFieldValueResult {
  changed: boolean
  field: string
  from: string | null
  to: string | null
}

/**
 * Write one key of companies.custom / contacts.custom, validated against its
 * field definition. Called by lib/edit/update.ts's updateEntity for any field
 * named "custom.<key>" -- the one door custom-field values are written through,
 * same as every other inline-edit field.
 */
export async function writeCustomFieldValue(db: Db, actor: string, input: WriteCustomFieldValueInput): Promise<WriteCustomFieldValueResult> {
  const table = input.entityType === 'company' ? 'lp.companies' : 'lp.contacts'
  const fieldName = `custom.${input.key}`
  return db.tx(async (q) => {
    const def = await fieldDefByKey(q, input.entityType, input.key)
    if (!def) throw new FieldError(`"${input.key}" is not a defined field on ${input.entityType}.`, 404)
    const nextValue = validateFieldValue(def, input.value)

    const { rows } = await q.query<{ custom: Record<string, unknown> }>(`select custom from ${table} where id = $1 for update`, [input.entityId])
    if (!rows[0]) throw new FieldError(`No ${input.entityType} found for that id.`, 404)
    const curCustom = rows[0].custom ?? {}
    const curValue = curCustom[input.key] ?? null
    const curText = curValue === null ? null : typeof curValue === 'string' ? curValue : JSON.stringify(curValue)
    const nextText = nextValue === null ? null : typeof nextValue === 'string' ? nextValue : JSON.stringify(nextValue)
    if (curText === nextText) return { changed: false, field: fieldName, from: curText, to: nextText }

    if (nextValue === null) {
      await q.query(`update ${table} set custom = custom - $2 where id = $1`, [input.entityId, input.key])
    } else {
      await q.query(`update ${table} set custom = jsonb_set(custom, $2, $3::jsonb, true) where id = $1`, [input.entityId, `{${input.key}}`, JSON.stringify(nextValue)])
    }
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.entityType, input.entityId, fieldName, curText, nextText, actor, input.via, input.note],
    )
    const companyId = input.entityType === 'company'
      ? input.entityId
      : (await q.query<{ company_id: number | null }>('select company_id from lp.contacts where id = $1', [input.entityId])).rows[0]?.company_id ?? null
    await safeOnFieldChanged(q, {
      entity: input.entityType,
      id: input.entityId,
      field: fieldName,
      from: curText,
      to: nextText,
      company_id: companyId,
      contact_id: input.entityType === 'contact' ? input.entityId : null,
    })
    return { changed: true, field: fieldName, from: curText, to: nextText }
  }, actor)
}
