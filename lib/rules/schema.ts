/**
 * Lead rules: what a lead must meet to be Ready for a campaign (requirements),
 * and the personalization fields sent with it. Stored per rule set in
 * lp.rule_sets (migration 0010) as ordered JSON arrays; this file is the one
 * definition of their shape, the field catalog and the validation every write
 * goes through (dashboard form, PUT /api/rules/:id, an agent's proposal).
 *
 * Standing rules are NOT in here and cannot be edited away; see standing.ts.
 */
import { CONTACT_STATUSES, RESEARCH_STATUSES, STAGES, VERIFICATION_STATUSES } from '../leads/types.ts'

/** Any pool slug in lp.pools (lib/pools/store.ts) — campaign-agnostic, not a fixed list. */
export type Segment = string

export const CONFIDENCES = ['low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const OPS = ['present', 'absent', 'eq', 'neq', 'in', 'not_in', 'contains', 'is_true', 'is_false'] as const
export type RuleOp = (typeof OPS)[number]

export const OP_WORDS: Record<RuleOp, string> = {
  present: 'is present',
  absent: 'is empty',
  eq: 'equals',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'contains',
  is_true: 'is yes',
  is_false: 'is no',
}

type FieldKind = 'text' | 'enum' | 'bool'

export interface FieldDef {
  key: string
  label: string
  kind: FieldKind
  options?: readonly string[]
  /**
   * This enum field's valid values are NOT the fixed `options` list — they are
   * "exists in lp.pools" (lib/pools/store.ts), enforced by the campaigns_pool_fk /
   * *_segment_fk foreign key at write time (lib/pools/store.ts's mapPoolFkError
   * maps a 23503 violation to a plain error). A caller with a live pool list can
   * still resolve real `options` for a dropdown (see lib/rules/store.ts's
   * resolveFieldCatalog) — this schema module stays DB-free.
   */
  dynamicOptions?: 'pools'
  /** min_confidence is allowed (the field carries a confidence). */
  confidence?: boolean
  /** max_age_days is allowed; the date it reads, in words. */
  dated?: string
}

/** Every lead field a rule or a personalization field can read. Enrichment facts are `enrichment:<key>`. */
export const FIELD_CATALOG: readonly FieldDef[] = [
  { key: 'contact.verification_status', label: 'Email status (verification)', kind: 'enum', options: VERIFICATION_STATUSES, dated: 'when the email was last verified' },
  { key: 'contact.status', label: 'Lead status', kind: 'enum', options: CONTACT_STATUSES },
  { key: 'contact.email', label: 'Email', kind: 'text' },
  { key: 'contact.email_source', label: 'Email source', kind: 'text' },
  { key: 'contact.is_role_address', label: 'Role inbox (info@, sales@...)', kind: 'bool' },
  { key: 'contact.first_name', label: 'First name', kind: 'text', confidence: true },
  { key: 'contact.last_name', label: 'Last name', kind: 'text', confidence: true },
  { key: 'contact.title', label: 'Title / role', kind: 'text' },
  { key: 'contact.phone', label: 'Contact phone', kind: 'text' },
  { key: 'contact.personalization', label: 'Personalization line (contact)', kind: 'text' },
  { key: 'company.name', label: 'Company name', kind: 'text' },
  { key: 'company.segment', label: 'Pool', kind: 'enum', dynamicOptions: 'pools', options: [] },
  { key: 'company.vertical', label: 'Vertical / business type', kind: 'text' },
  { key: 'company.website_domain', label: 'Website', kind: 'text' },
  { key: 'company.phone', label: 'Store phone', kind: 'text' },
  { key: 'company.city', label: 'City', kind: 'text' },
  { key: 'company.state', label: 'State', kind: 'text' },
  { key: 'company.owner_name', label: 'Owner name (company)', kind: 'text', dated: 'when the company was last researched' },
  { key: 'company.stage', label: 'Stage', kind: 'enum', options: STAGES },
  { key: 'company.research_status', label: 'Research status', kind: 'enum', options: RESEARCH_STATUSES, dated: 'when the company was last researched' },
]

export const ENRICHMENT_PREFIX = 'enrichment:'
const ENRICHMENT_KEY = /^[a-z0-9][a-z0-9_]{0,39}$/

export function fieldDef(key: string): FieldDef | null {
  const f = FIELD_CATALOG.find((d) => d.key === key)
  if (f) return f
  if (key.startsWith(ENRICHMENT_PREFIX) && ENRICHMENT_KEY.test(key.slice(ENRICHMENT_PREFIX.length))) {
    const k = key.slice(ENRICHMENT_PREFIX.length)
    return { key, label: `Fact: ${k.replace(/_/g, ' ')}`, kind: 'text', confidence: true, dated: 'when the fact was last checked' }
  }
  return null
}

export function fieldLabel(key: string): string {
  return fieldDef(key)?.label ?? key
}

export interface Requirement {
  id: string
  label?: string | null
  enabled: boolean
  field: string
  op: RuleOp
  /** eq/neq/contains: a string; in/not_in: a list; otherwise absent. */
  value?: string | string[] | null
  min_confidence?: Confidence | null
  max_age_days?: number | null
}

export interface PersonalizationField {
  id: string
  /** The merge key sent to Instantly as a custom variable ({{name}}). */
  name: string
  source: string
  /** Needed for Ready-personalized: without a real value the lead is Ready-generic. */
  required: boolean
  /** Sent when there is no real value. Never counts as a real value. */
  fallback?: string | null
  min_confidence?: Confidence | null
  max_age_days?: number | null
  enabled: boolean
}

export interface RuleDoc {
  name: string
  requirements: Requirement[]
  fields: PersonalizationField[]
}

export class RulesError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RulesError'
    this.status = status
  }
}

const MAX_ITEMS = 40
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const MERGE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

function newId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}-${Date.now().toString(36)}-${i}`
    if (!taken.has(id)) return id
  }
}

function text(v: unknown, what: string, max: number, required = true): string | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new RulesError(`${what} is required.`)
    return null
  }
  if (typeof v !== 'string') throw new RulesError(`${what} must be text.`)
  const t = v.trim()
  if (t.length > max) throw new RulesError(`${what} is longer than ${max} characters.`)
  return t
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'on' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'off' || v === 'no' || v === '0') return false
  throw new RulesError(`"${String(v)}" is not yes or no.`)
}

function confidence(v: unknown, def: FieldDef, what: string): Confidence | null {
  if (v == null || v === '') return null
  if (!(CONFIDENCES as readonly string[]).includes(String(v))) throw new RulesError(`${what}: confidence must be low, medium or high.`)
  if (!def.confidence) throw new RulesError(`${what}: "${def.label}" has no confidence to check.`)
  return v as Confidence
}

function maxAge(v: unknown, def: FieldDef, what: string): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new RulesError(`${what}: age limit must be a whole number of days, 1 to 3650.`)
  if (!def.dated) throw new RulesError(`${what}: "${def.label}" has no date to check its age against.`)
  return n
}

function listValue(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const set = new Set<string>()
  for (const x of arr) {
    const s = String(x).trim()
    if (s) set.add(s)
  }
  return Array.from(set)
}

export function parseRequirement(raw: unknown, taken: Set<string>, n: number): Requirement {
  if (!raw || typeof raw !== 'object') throw new RulesError(`Requirement ${n} is not an object.`)
  const r = raw as Record<string, unknown>
  const what = `Requirement ${n}`
  const field = text(r.field, `${what}: field`, 80) as string
  const def = fieldDef(field)
  if (!def) throw new RulesError(`${what}: unknown field "${field}". Use one of the listed fields, or enrichment:<fact key>.`)
  const op = String(r.op ?? '') as RuleOp
  if (!(OPS as readonly string[]).includes(op)) throw new RulesError(`${what}: unknown condition "${String(r.op)}".`)
  if ((op === 'is_true' || op === 'is_false') !== (def.kind === 'bool')) {
    throw new RulesError(def.kind === 'bool' ? `${what}: "${def.label}" is yes/no; use "is yes" or "is no".` : `${what}: "is yes / is no" only fits a yes/no field.`)
  }
  let value: string | string[] | null = null
  if (op === 'in' || op === 'not_in') {
    const list = listValue(r.value)
    if (!list.length) throw new RulesError(`${what}: list at least one value.`)
    if (list.length > 50) throw new RulesError(`${what}: at most 50 values.`)
    if (def.kind === 'enum' && !def.dynamicOptions) for (const x of list) if (!def.options!.includes(x)) throw new RulesError(`${what}: "${x}" is not a ${def.label} value (${def.options!.join(', ')}).`)
    value = list
  } else if (op === 'eq' || op === 'neq' || op === 'contains') {
    const v = text(Array.isArray(r.value) ? r.value[0] : r.value, `${what}: value`, 200) as string
    if (def.kind === 'enum' && op !== 'contains' && !def.dynamicOptions && !def.options!.includes(v)) throw new RulesError(`${what}: "${v}" is not a ${def.label} value (${def.options!.join(', ')}).`)
    value = v
  }
  const id = typeof r.id === 'string' && ID.test(r.id) && !taken.has(r.id) ? r.id : newId('r', taken)
  taken.add(id)
  return {
    id,
    label: text(r.label, `${what}: label`, 120, false),
    enabled: bool(r.enabled, true),
    field,
    op,
    ...(value !== null ? { value } : {}),
    min_confidence: confidence(r.min_confidence, def, what),
    max_age_days: maxAge(r.max_age_days, def, what),
  }
}

export function parseField(raw: unknown, taken: Set<string>, names: Set<string>, n: number): PersonalizationField {
  if (!raw || typeof raw !== 'object') throw new RulesError(`Personalization field ${n} is not an object.`)
  const r = raw as Record<string, unknown>
  const what = `Personalization field ${n}`
  const name = text(r.name, `${what}: name`, 40) as string
  if (!MERGE_NAME.test(name)) throw new RulesError(`${what}: name "${name}" must start with a letter and use only letters, digits and _ (it becomes {{${name}}} in Instantly).`)
  if (names.has(name.toLowerCase())) throw new RulesError(`${what}: two fields are both named "${name}".`)
  names.add(name.toLowerCase())
  const source = text(r.source, `${what}: source`, 80) as string
  const def = fieldDef(source)
  if (!def) throw new RulesError(`${what}: unknown source "${source}". Use one of the listed fields, or enrichment:<fact key>.`)
  if (def.kind === 'bool') throw new RulesError(`${what}: a yes/no field can't be a personalization value.`)
  const id = typeof r.id === 'string' && ID.test(r.id) && !taken.has(r.id) ? r.id : newId('f', taken)
  taken.add(id)
  return {
    id,
    name,
    source,
    required: bool(r.required, false),
    fallback: text(r.fallback, `${what}: fallback`, 500, false),
    min_confidence: confidence(r.min_confidence, def, what),
    max_age_days: maxAge(r.max_age_days, def, what),
    enabled: bool(r.enabled, true),
  }
}

/** Validate a whole rule document (name + ordered requirements + ordered fields). Throws RulesError. */
export function parseRuleDoc(raw: unknown): RuleDoc {
  if (!raw || typeof raw !== 'object') throw new RulesError('Body must be JSON: {name, requirements: [...], fields: [...]}')
  const r = raw as Record<string, unknown>
  const name = text(r.name, 'Name', 120) as string
  if (!Array.isArray(r.requirements)) throw new RulesError('requirements must be a list.')
  if (!Array.isArray(r.fields)) throw new RulesError('fields must be a list.')
  if (r.requirements.length > MAX_ITEMS || r.fields.length > MAX_ITEMS) throw new RulesError(`At most ${MAX_ITEMS} requirements and ${MAX_ITEMS} fields.`)
  const reqIds = new Set<string>()
  const fieldIds = new Set<string>()
  const names = new Set<string>()
  // Keep submitted ids where valid (so the log can say which rule changed).
  const requirements = r.requirements.map((x, i) => parseRequirement(x, reqIds, i + 1))
  const fields = r.fields.map((x, i) => parseField(x, fieldIds, names, i + 1))
  return { name, requirements, fields }
}

/** One line a person can read: "Email status (verification) is one of valid". */
export function describeRequirement(r: Requirement): string {
  if (r.label) return r.label
  const v = Array.isArray(r.value) ? r.value.join(', ') : r.value ?? ''
  const extra = [r.min_confidence ? `confidence ≥ ${r.min_confidence}` : '', r.max_age_days ? `checked within ${r.max_age_days} days` : ''].filter(Boolean)
  return `${fieldLabel(r.field)} ${OP_WORDS[r.op]}${v ? ` ${v}` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`
}

export function describeField(f: PersonalizationField): string {
  const extra = [f.required ? 'required for personalized' : 'optional', f.fallback ? `fallback "${f.fallback}"` : 'no fallback']
  return `{{${f.name}}} from ${fieldLabel(f.source)} (${extra.join(', ')})`
}
