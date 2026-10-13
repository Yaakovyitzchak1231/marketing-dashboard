/**
 * The universal inline-edit whitelist (plan item 1.3): every entity type the
 * dashboard's inline-edit cells, or an agent through the `update_entity` ops,
 * can change one field on — with its label, its validation, and (for company
 * and contact) a pointer to the existing #45 lead-edit writer that already
 * normalizes and writes it.
 *
 * This is the one source of truth for "what can be edited" on company and
 * contact: lib/leads/edit-fields.ts re-exports CONTACT_EDIT_FIELDS,
 * COMPANY_EDIT_FIELDS and FIELD_LABELS from here so lib/leads/edit.ts (the
 * existing lead-edit code, #45) keeps working unchanged.
 */
import { CONTACT_STATUSES } from '../leads/types'
import { parseOverrides } from '../campaigns/types'

export type EntityType = 'company' | 'contact' | 'campaign' | 'campaign_lead' | 'task'
export const ENTITY_TYPES: readonly EntityType[] = ['company', 'contact', 'campaign', 'campaign_lead', 'task']

export class RegistryError extends Error {
  status: 400 | 403 | 404 | 409
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

/** How update.ts should write a field once it is validated. */
export type FieldWriter =
  /** Delegate to lib/leads/edit.ts's editCompany/editContact, which already validate, dedupe-check,
   *  normalize and write their own status_history rows (and skip it for trigger-owned fields). */
  | { kind: 'lead_edit' }
  /** A plain column on the entity's own table; update.ts writes it and the status_history row itself.
   *  `trigger` true means a DB trigger already logs this field — update.ts must NOT also log it. */
  | { kind: 'direct'; table: string; column?: string; trigger?: boolean }

export interface FieldDef {
  label: string
  writer: FieldWriter
  /** Validate + normalize raw input into the value to store (or null to clear). Throws RegistryError. */
  validate: (raw: unknown) => string | null
}

type Registry = Partial<Record<EntityType, Record<string, FieldDef>>>

// ---------------------------------------------------------------- shared validators

function textField(label: string, opts: { required?: boolean; max?: number; collapse?: boolean } = {}) {
  return (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') {
      if (opts.required) throw new RegistryError(`${label} is required.`)
      return null
    }
    if (typeof raw !== 'string') throw new RegistryError(`${label} must be text.`)
    const s = opts.collapse === false ? raw.trim() : raw.trim().replace(/\s+/g, ' ')
    if (!s) {
      if (opts.required) throw new RegistryError(`${label} is required.`)
      return null
    }
    if (opts.max && s.length > opts.max) throw new RegistryError(`${label} is too long (max ${opts.max} characters).`)
    return s
  }
}

function enumField(label: string, values: readonly string[]) {
  return (raw: unknown): string => {
    if (raw === null || raw === undefined || raw === '') throw new RegistryError(`${label} is required.`)
    if (typeof raw !== 'string' || !values.includes(raw)) throw new RegistryError(`${label} must be one of: ${values.join(', ')}.`)
    return raw
  }
}

/** Any lowercase slug, letter-first (campaign pool is "any slug now, no fixed list" — migration 0020). */
const SLUG_RE = /^[a-z][a-z0-9_]{0,40}$/
function slugField(label: string) {
  return (raw: unknown): string => {
    if (typeof raw !== 'string' || !SLUG_RE.test(raw.trim())) throw new RegistryError(`${label} must be a lowercase slug (letters, digits, _; starts with a letter).`)
    return raw.trim()
  }
}

/** JSON object field (campaign_lead.overrides), stored and compared as a sorted JSON string. */
function jsonObjectField(label: string) {
  return (raw: unknown): string => {
    let obj: unknown = raw
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw)
      } catch {
        throw new RegistryError(`${label} must be a JSON object.`)
      }
    }
    const cleaned = parseOverrides(obj)
    return JSON.stringify(cleaned)
  }
}

/** Optional positive integer id (campaign.rule_set_id); '' / null clears it. Stored as its decimal text. */
function optionalIdField(label: string) {
  return (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') return null
    const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) throw new RegistryError(`${label} must be an id number, or empty for none.`)
    return String(Number(s))
  }
}

/** Yes/no (campaign.is_template), stored and compared as 'true' / 'false' (how Postgres booleans read back). */
function booleanField(label: string) {
  return (raw: unknown): string => {
    if (raw === true || raw === false) return String(raw)
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (['true', 'yes', '1', 'on'].includes(s)) return 'true'
    if (['false', 'no', '0', 'off'].includes(s)) return 'false'
    throw new RegistryError(`${label} must be yes or no.`)
  }
}

// ---------------------------------------------------------------- the registry

/** Reused by lib/leads/edit-fields.ts (don't duplicate; the #45 definitions live here now). */
export const CONTACT_EDIT_FIELDS = ['first_name', 'last_name', 'email', 'title', 'phone', 'status'] as const
export const COMPANY_EDIT_FIELDS = ['name', 'website', 'phone', 'city', 'state'] as const
export type ContactEditField = (typeof CONTACT_EDIT_FIELDS)[number]
export type CompanyEditField = (typeof COMPANY_EDIT_FIELDS)[number]
export type ContactPatch = Partial<Record<ContactEditField, string | null>>
export type CompanyPatch = Partial<Record<CompanyEditField, string | null>>

export const EDITABLE_CONTACT_STATUSES = CONTACT_STATUSES
export const STATUSES_RESET_BY_EMAIL_CHANGE: readonly string[] = ['verifying', 'valid-ready', 'catch-all-hold']

export const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', email: 'Email', title: 'Title', phone: 'Phone',
  status: 'Status', name: 'Name', website: 'Website', city: 'City', state: 'State',
  verification_status: 'Email status', stage: 'Stage',
  goal: 'Goal', notes: 'Notes', owner: 'Owner', pool: 'Pool', rule_set_id: 'Rules', is_template: 'Template',
  note: 'Note', overrides: 'Overrides',
  priority: 'Priority', title_task: 'Title',
}

const lead_edit: FieldWriter = { kind: 'lead_edit' }

export const REGISTRY: Registry = {
  company: {
    name: { label: 'Name', writer: lead_edit, validate: textField('Name', { required: true, max: 200 }) },
    website: { label: 'Website', writer: lead_edit, validate: textField('Website', { max: 500 }) },
    phone: { label: 'Phone', writer: lead_edit, validate: textField('Phone', { max: 40 }) },
    city: { label: 'City', writer: lead_edit, validate: textField('City', { max: 100 }) },
    state: { label: 'State', writer: lead_edit, validate: textField('State', { max: 50 }) },
    // Not in lib/leads/edit.ts: company.stage already has its own DB trigger (companies_stage_log,
    // migration 0001) that writes lp.status_history on insert/update of stage. update.ts writes the
    // column directly and must NOT also insert a status_history row here (that would double-log).
    stage: {
      label: 'Stage', writer: { kind: 'direct', table: 'lp.companies', trigger: true },
      validate: enumField('Stage', ['new', 'researched', 'ready', 'in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won', 'lost', 'do_not_contact']),
    },
  },
  contact: {
    first_name: { label: 'First name', writer: lead_edit, validate: textField('First name', { max: 100 }) },
    last_name: { label: 'Last name', writer: lead_edit, validate: textField('Last name', { max: 100 }) },
    email: { label: 'Email', writer: lead_edit, validate: textField('Email', { max: 320, collapse: false }) },
    title: { label: 'Title', writer: lead_edit, validate: textField('Title', { max: 200 }) },
    phone: { label: 'Phone', writer: lead_edit, validate: textField('Phone', { max: 40 }) },
    // contact.status (and verification_status) already have a DB trigger (contacts_status_log,
    // migration 0001) writing lp.status_history. editContact (lib/leads/edit.ts) already knows to
    // skip its own status_history write for this field, so no "trigger: true" bookkeeping is needed
    // here — the lead_edit writer already does the right thing.
    status: { label: 'Status', writer: lead_edit, validate: enumField('Status', CONTACT_STATUSES) },
  },
  campaign: {
    name: { label: 'Name', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: textField('Name', { required: true, max: 120 }) },
    goal: { label: 'Goal', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: textField('Goal', { max: 500 }) },
    notes: { label: 'Notes', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: textField('Notes', { max: 5000, collapse: false }) },
    status: { label: 'Status', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: slugField('Status') },
    owner: { label: 'Owner', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: textField('Owner', { max: 63 }) },
    // Migration 0020 (then the schema-v2 pass, Oct 11): pools are rows in lp.pools now, and
    // lp.campaigns.pool is a foreign key to it. Validate only the slug shape here — NOT against
    // lib/campaigns/types.ts's POOLS constant (the old fixed list, used elsewhere, is being retired) —
    // and let the DB's FK refuse an unknown pool; update.ts maps that (code 23503) to "Unknown pool".
    pool: { label: 'Pool', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: slugField('Pool') },
    // Pool and rules are person-only, owner must be a teammate, status must be live, and a rule set
    // must be usable: update.ts runs lib/campaigns/store.ts's guardCampaignEdit (the same checks the
    // old Settings form's updateCampaign ran) before writing any campaign field.
    rule_set_id: { label: 'Rules', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: optionalIdField('Rules') },
    is_template: { label: 'Template', writer: { kind: 'direct', table: 'lp.campaigns' }, validate: booleanField('Template') },
  },
  campaign_lead: {
    note: { label: 'Note', writer: { kind: 'direct', table: 'lp.campaign_leads' }, validate: textField('Note', { max: 2000, collapse: false }) },
    overrides: { label: 'Overrides', writer: { kind: 'direct', table: 'lp.campaign_leads' }, validate: jsonObjectField('Overrides') },
  },
  task: {
    title: { label: 'Title', writer: { kind: 'direct', table: 'lp.tasks' }, validate: textField('Title', { required: true, max: 300 }) },
    priority: {
      label: 'Priority',
      writer: { kind: 'direct', table: 'lp.tasks' },
      validate: (raw) => {
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n)) throw new RegistryError('Priority must be a whole number.')
        return String(n)
      },
    },
    // "status where safe": the same status machine update_task (lib/ops/core.ts) enforces, so a
    // claimed task can't be yanked out from under its agent through the generic inline-edit path.
    status: { label: 'Status', writer: { kind: 'direct', table: 'lp.tasks' }, validate: enumField('Status', ['queued', 'blocked', 'cancelled', 'done']) },
  },
}

export function fieldDef(type: string, field: string): FieldDef {
  const entity = (REGISTRY as Registry)[type as EntityType]
  if (!entity) throw new RegistryError(`"${type}" is not an editable entity type. Entities: ${ENTITY_TYPES.join(', ')}.`, 404)
  const def = entity[field]
  if (!def) throw new RegistryError(`"${field}" can't be edited on a ${type}. Fields: ${Object.keys(entity).join(', ')}.`, 404)
  return def
}
