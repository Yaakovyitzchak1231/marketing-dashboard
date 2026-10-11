/**
 * Custom fields (plan item 1.7): pure types + the field registry read, shared by
 * the fields ops (lib/fields/store.ts), the universal inline-edit writer
 * (lib/edit/update.ts, for writing a value into companies.custom / contacts.custom)
 * and, later, the segment engine (lib/segments/fields.ts) -- which should import
 * ONLY listFieldDefs from here, not the write path.
 */
import type { Queryable } from '../db/types'

export type FieldEntity = 'company' | 'contact'
export type FieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'url' | 'boolean'

export const FIELD_ENTITIES: readonly FieldEntity[] = ['company', 'contact']
export const FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'date', 'select', 'multi_select', 'url', 'boolean']

export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/

export class FieldError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

export interface FieldDefRow {
  id: number
  entity: FieldEntity
  key: string
  label: string
  type: FieldType
  options: string[]
  campaign_id: number | null
  sort: number
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function rowOut(r: Record<string, unknown>): FieldDefRow {
  return {
    id: Number(r.id),
    entity: r.entity as FieldEntity,
    key: String(r.key),
    label: String(r.label),
    type: r.type as FieldType,
    options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : typeof r.options === 'string' ? JSON.parse(r.options) : [],
    campaign_id: r.campaign_id == null ? null : Number(r.campaign_id),
    sort: Number(r.sort ?? 100),
    archived_at: (r.archived_at as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

/**
 * Every live (or, with include_archived, every) field definition, optionally
 * scoped to one entity. The one function other features (the segment engine,
 * the lead-edit UI, the CSV importer) should import from here.
 */
export async function listFieldDefs(
  db: Queryable,
  opts: { entity?: FieldEntity; include_archived?: boolean; campaign_id?: number | null } = {},
): Promise<FieldDefRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (!opts.include_archived) where.push('archived_at is null')
  if (opts.entity) {
    params.push(opts.entity)
    where.push(`entity = $${params.length}`)
  }
  if (opts.campaign_id !== undefined) {
    if (opts.campaign_id === null) {
      where.push('campaign_id is null')
    } else {
      params.push(opts.campaign_id)
      where.push(`(campaign_id is null or campaign_id = $${params.length})`)
    }
  }
  const sql = `select * from lp.field_defs ${where.length ? `where ${where.join(' and ')}` : ''} order by entity, sort, label`
  const { rows } = await db.query<Record<string, unknown>>(sql, params)
  return rows.map(rowOut)
}

/**
 * True when a DB error is Postgres saying a relation/column is missing (the
 * shape of every "migration 0025 hasn't run yet" failure on a preview DB,
 * which never migrates). Never matches a different failure (a bad query, a
 * connection drop, a constraint violation) -- those must still throw.
 */
export function isMissingTableError(e: unknown): boolean {
  return /does not exist/i.test((e as { message?: string })?.message ?? '')
}

export interface FieldDefsRead {
  defs: FieldDefRow[]
  needsMigration: boolean
}

/**
 * Same as listFieldDefs, but honest when migration 0025 hasn't run on this
 * database yet (every preview DB, and prod before its next deploy): returns
 * an empty list with needsMigration: true instead of throwing, so a page that
 * reads it can render normally with the custom-fields section hidden or
 * noted, rather than crashing. Any other error still throws.
 */
export async function listFieldDefsSafe(
  db: Queryable,
  opts: { entity?: FieldEntity; include_archived?: boolean; campaign_id?: number | null } = {},
): Promise<FieldDefsRead> {
  try {
    return { defs: await listFieldDefs(db, opts), needsMigration: false }
  } catch (e) {
    if (isMissingTableError(e)) return { defs: [], needsMigration: true }
    throw e
  }
}

export async function fieldDefByKey(db: Queryable, entity: FieldEntity, key: string): Promise<FieldDefRow | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    'select * from lp.field_defs where entity = $1 and key = $2 and archived_at is null limit 1',
    [entity, key],
  )
  return rows[0] ? rowOut(rows[0]) : null
}

const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate + normalize one raw value against a field's type. Returns the
 * JSON-storable value, or null to clear the key. Throws FieldError on a bad
 * value (e.g. "abc" for a number, an option not in the field's list).
 */
export function validateFieldValue(def: Pick<FieldDefRow, 'label' | 'type' | 'options'>, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  switch (def.type) {
    case 'text': {
      const s = String(raw).trim()
      if (!s) return null
      if (s.length > 2000) throw new FieldError(`${def.label} is too long (max 2000 characters).`)
      return s
    }
    case 'url': {
      const s = String(raw).trim()
      if (!s) return null
      if (s.length > 2000 || !URL_RE.test(s)) throw new FieldError(`${def.label} must be a URL starting with http:// or https://.`)
      return s
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (typeof raw !== 'number' && String(raw).trim() === '') return null
      if (!Number.isFinite(n)) throw new FieldError(`${def.label} must be a number.`)
      return n
    }
    case 'boolean': {
      if (raw === true || raw === false) return raw
      const s = String(raw).trim().toLowerCase()
      if (['true', 'yes', '1', 'on'].includes(s)) return true
      if (['false', 'no', '0', 'off'].includes(s)) return false
      throw new FieldError(`${def.label} must be yes or no.`)
    }
    case 'date': {
      const s = String(raw).trim()
      if (!s) return null
      const d = new Date(s)
      if (!DATE_RE.test(s) || Number.isNaN(d.getTime())) throw new FieldError(`${def.label} must be a date (YYYY-MM-DD).`)
      return s
    }
    case 'select': {
      const s = String(raw).trim()
      if (!s) return null
      if (!def.options.includes(s)) throw new FieldError(`${def.label} must be one of: ${def.options.join(', ') || '(no options defined)'}.`)
      return s
    }
    case 'multi_select': {
      const list = Array.isArray(raw)
        ? raw.map(String)
        : String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      if (!list.length) return null
      const bad = list.find((v) => !def.options.includes(v))
      if (bad) throw new FieldError(`"${bad}" is not one of ${def.label}'s options: ${def.options.join(', ') || '(no options defined)'}.`)
      return Array.from(new Set(list))
    }
    default:
      throw new FieldError(`Unknown field type "${def.type}".`)
  }
}
