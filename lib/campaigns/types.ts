/**
 * Campaigns workspace: the shapes and the input checks. Pure (no DB, no React)
 * so the pages, the ops API and the tests share one contract.
 */
export const POOLS = ['jeweler', 'ai_agency', 'ai_builder', 'other'] as const
export type Pool = (typeof POOLS)[number]
export const POOL_LABELS: Record<Pool, string> = {
  jeweler: 'Jewelers',
  ai_agency: 'AI agencies',
  ai_builder: 'AI builders',
  other: 'Other',
}

export interface CampaignStatus {
  id: string
  label: string
  sort: number
  is_archived: boolean
  active: boolean
}

export interface Campaign {
  id: number
  name: string
  pool: Pool
  goal: string | null
  notes: string | null
  owner: string | null
  status: string
  rule_set_id: number | null
  based_on: number | null
  is_template: boolean
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export interface CampaignSummary extends Campaign {
  status_label: string
  status_archived: boolean
  owner_name: string | null
  lead_count: number
}

/** Fields a person or an agent can set on a campaign. */
export const CAMPAIGN_FIELDS = ['name', 'pool', 'goal', 'notes', 'owner', 'status', 'rule_set_id', 'is_template'] as const
export type CampaignField = (typeof CAMPAIGN_FIELDS)[number]
export type CampaignPatch = Partial<{
  name: string
  pool: Pool
  goal: string | null
  notes: string | null
  owner: string | null
  status: string
  rule_set_id: number | null
  is_template: boolean
}>

export const FIELD_WORDS: Record<CampaignField, string> = {
  name: 'Name',
  pool: 'Pool',
  goal: 'Goal',
  notes: 'Notes',
  owner: 'Owner',
  status: 'Status',
  rule_set_id: 'Rules',
  is_template: 'Template',
}

export class CampaignError extends Error {
  status: 400 | 403 | 404 | 409
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

const LIMITS = { name: 120, goal: 500, notes: 5000 } as const

function text(field: 'name' | 'goal' | 'notes', v: unknown, required: boolean): string | null {
  if (v === null || v === undefined) {
    if (required) throw new CampaignError(`${FIELD_WORDS[field]} is required.`)
    return null
  }
  if (typeof v !== 'string') throw new CampaignError(`${FIELD_WORDS[field]} must be text.`)
  const s = field === 'notes' ? v.trim() : v.trim().replace(/\s+/g, ' ')
  if (!s) {
    if (required) throw new CampaignError(`${FIELD_WORDS[field]} is required.`)
    return null
  }
  if (s.length > LIMITS[field]) throw new CampaignError(`${FIELD_WORDS[field]} is too long (max ${LIMITS[field]} characters).`)
  return s
}

function bool(field: CampaignField, v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'on' || v === '1' || v === 1) return true
  if (v === 'false' || v === '' || v === '0' || v === 0 || v === null) return false
  throw new CampaignError(`${FIELD_WORDS[field]} must be true or false.`)
}

/**
 * Check a patch from a form or a JSON body. Unknown keys are refused (not
 * silently dropped). `create` makes name required.
 */
export function parseCampaignPatch(body: unknown, opts: { create?: boolean } = {}): CampaignPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CampaignError('Send the campaign fields as JSON.')
  const out: CampaignPatch = {}
  const b = body as Record<string, unknown>
  for (const k of Object.keys(b)) {
    if (!(CAMPAIGN_FIELDS as readonly string[]).includes(k)) throw new CampaignError(`${k} can't be set on a campaign.`)
  }
  if ('name' in b || opts.create) out.name = text('name', b.name, true) as string
  if ('goal' in b) out.goal = text('goal', b.goal, false)
  if ('notes' in b) out.notes = text('notes', b.notes, false)
  if ('pool' in b) {
    if (!(POOLS as readonly unknown[]).includes(b.pool)) throw new CampaignError(`Pool must be one of: ${POOLS.join(', ')}.`)
    out.pool = b.pool as Pool
  }
  if ('owner' in b) {
    const o = b.owner
    if (o === null || o === '') out.owner = null
    else if (typeof o === 'string' && /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(o.trim().toLowerCase())) out.owner = o.trim().toLowerCase()
    else throw new CampaignError('Owner must be a teammate id (e.g. owner, tab, hermes).')
  }
  if ('status' in b) {
    if (typeof b.status !== 'string' || !/^[a-z][a-z0-9_]{0,30}$/.test(b.status.trim())) throw new CampaignError('Status must be a status id (e.g. draft, active).')
    out.status = b.status.trim()
  }
  if ('rule_set_id' in b) {
    const r = b.rule_set_id
    if (r === null || r === '' || r === undefined) out.rule_set_id = null
    else {
      const n = Number(r)
      if (!Number.isInteger(n) || n <= 0) throw new CampaignError('Rules must be a rule set id, or empty for the pool’s rules.')
      out.rule_set_id = n
    }
  }
  if ('is_template' in b) out.is_template = bool('is_template', b.is_template)
  if (!opts.create && !Object.keys(out).length) throw new CampaignError('Nothing to change.')
  return out
}

/** Per-lead personalization overrides: {name: value}. Keys are the rules' merge field names ({{firstName}} -> firstName). */
export const OVERRIDE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/
export function parseOverrides(v: unknown): Record<string, string> {
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new CampaignError('Overrides must be an object of field -> text.')
  const out: Record<string, string> = {}
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > 50) throw new CampaignError('At most 50 overrides per lead.')
  for (const [k, val] of entries) {
    const key = k.trim()
    if (!OVERRIDE_KEY.test(key)) throw new CampaignError(`"${k}" is not a field name (starts with a letter; letters, digits, _).`)
    if (val === null || val === undefined || val === '') continue // blank = remove the override
    if (typeof val !== 'string' && typeof val !== 'number') throw new CampaignError(`The override for ${key} must be text.`)
    const s = String(val).trim()
    if (s.length > 1000) throw new CampaignError(`The override for ${key} is too long (max 1000 characters).`)
    if (s) out[key] = s
  }
  return out
}

/** "key = value" lines (the lead edit box) -> overrides. */
export function overridesFromLines(raw: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const i = t.search(/[=:]/)
    if (i <= 0) throw new CampaignError(`"${t.slice(0, 40)}" needs to look like key = value.`)
    obj[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return parseOverrides(obj)
}

export function overridesToLines(o: Record<string, string> | null | undefined): string {
  return Object.entries(o ?? {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
}

export const TAG_RE = /^[a-z0-9][a-z0-9 _-]{0,39}$/
export function parseTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v == null ? [] : null
  if (!list) throw new CampaignError('Tags must be a list or comma-separated text.')
  const out = new Set<string>()
  for (const x of list) {
    if (typeof x !== 'string') throw new CampaignError('Each tag must be text.')
    const t = x.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!t) continue
    if (!TAG_RE.test(t)) throw new CampaignError(`"${x}" is not a tag (letters, digits, space, - and _; up to 40).`)
    out.add(t)
  }
  if (out.size > 30) throw new CampaignError('At most 30 tags per lead.')
  return [...out]
}

/** Filter for adding leads in bulk (and for narrowing a campaign's lead table). */
export interface LeadPick {
  pool?: Pool | null
  stage?: string | null
  contact_status?: string | null
  verification?: string | null
  state?: string | null
  tag?: string | null
  q?: string | null
}

export const MAX_ADD_BY_FILTER = 30_000
export const MAX_IDS = 1_000

export function parseIds(v: unknown, what = 'lead ids'): number[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null
  if (!list) throw new CampaignError(`Send ${what} as a list.`)
  const out = new Set<number>()
  for (const x of list) {
    if (x === '' || x === null || x === undefined) continue
    const n = Number(x)
    if (!Number.isInteger(n) || n <= 0) throw new CampaignError(`${String(x).slice(0, 20)} is not a lead id.`)
    out.add(n)
  }
  if (!out.size) throw new CampaignError(`No ${what} given.`)
  if (out.size > MAX_IDS) throw new CampaignError(`At most ${MAX_IDS} ${what} at a time; use a filter for more.`)
  return [...out]
}

export function parsePick(v: unknown): LeadPick {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CampaignError('The filter must be an object.')
  const b = v as Record<string, unknown>
  const allowed = ['pool', 'stage', 'contact_status', 'verification', 'state', 'tag', 'q']
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new CampaignError(`Unknown filter "${k}". Filters: ${allowed.join(', ')}.`)
  const s = (k: string, max = 120) => {
    const x = b[k]
    if (x === undefined || x === null || x === '' || x === 'all') return null
    if (typeof x !== 'string') throw new CampaignError(`Filter ${k} must be text.`)
    const t = x.trim()
    if (t.length > max) throw new CampaignError(`Filter ${k} is too long.`)
    return t || null
  }
  const pool = s('pool')
  if (pool && !(POOLS as readonly string[]).includes(pool)) throw new CampaignError(`Pool must be one of: ${POOLS.join(', ')}.`)
  const state = s('state', 50)
  const tag = s('tag', 40)
  return {
    pool: pool as Pool | null,
    stage: s('stage', 40),
    contact_status: s('contact_status', 40),
    verification: s('verification', 40),
    state: state ? state.toUpperCase() : null,
    tag: tag ? tag.toLowerCase() : null,
    q: s('q'),
  }
}

export function pickIsEmpty(p: LeadPick): boolean {
  return !Object.values(p).some((x) => x)
}

export function describePick(p: LeadPick): string {
  const parts: string[] = []
  if (p.pool) parts.push(`pool ${POOL_LABELS[p.pool]}`)
  if (p.stage) parts.push(`stage ${p.stage}`)
  if (p.contact_status) parts.push(`email status ${p.contact_status}`)
  if (p.verification) parts.push(`verification ${p.verification}`)
  if (p.state) parts.push(`state ${p.state}`)
  if (p.tag) parts.push(`tag "${p.tag}"`)
  if (p.q) parts.push(`matching "${p.q}"`)
  return parts.length ? parts.join(', ') : 'all leads'
}
