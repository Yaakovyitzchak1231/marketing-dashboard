/**
 * Campaign profiles: one per campaign (industry, vertical, ICP, UTM, KPIs) plus
 * its lists (campaign_profile_items — keywords, competitors, feeds, forums,
 * directories, trade shows, signal rules, fingerprints, social channels,
 * negative keywords). Nothing here is specific to any industry: the campaign
 * profile is what tells every later feature (news monitor, trend charts,
 * competitor tracking, lead-source connectors, buying signals, lookalikes,
 * the digest) what to look for, per campaign (lp.campaigns.id).
 *
 * Every write records one lp.status_history row (entity_type
 * 'campaign_profile', entity_id = campaign id, field e.g. 'industry' or
 * 'item:competitor:Toast'), naming the actor and the door it came through.
 * Only 'approved' items are meant to be read by monitors/connectors/signal
 * jobs: that's what approvedItems() returns, and it's the ONE function those
 * later features should call.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'

export class ProfileError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface IcpSize {
  employees_min?: number | null
  employees_max?: number | null
  revenue_min?: number | null
  revenue_max?: number | null
}
export interface Icp {
  business_types?: string[]
  size?: IcpSize
  geographies?: string[]
  roles?: string[]
  exclude?: string[]
}
export interface Utm {
  source?: string | null
  medium?: string | null
  campaign?: string | null
  content_rule?: string | null
}
export interface Kpi {
  metric: string
  target: number
  period: string
}

export type SetupStatus = 'draft' | 'suggested' | 'reviewed' | 'active'

export interface CampaignProfile {
  campaign_id: number
  industry: string | null
  vertical: string | null
  description: string | null
  icp: Icp
  value_prop: string | null
  newsletter_list: string | null
  utm: Utm
  kpis: Kpi[]
  setup_status: SetupStatus
  ai_last_suggested_at: Date | null
  ai_model: string | null
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export const ITEM_KINDS = [
  'keyword', 'topic', 'competitor', 'feed', 'forum', 'directory', 'trade_show',
  'signal_rule', 'fingerprint', 'social_channel', 'negative_keyword',
  'search_phrase', 'place_category',
] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export const ITEM_STATUSES = ['suggested', 'approved', 'rejected', 'archived'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export const ITEM_SOURCES = ['human', 'ai', 'agent', 'import', 'copied'] as const
export type ItemSource = (typeof ITEM_SOURCES)[number]

export const VERIFY_STATUSES = ['unchecked', 'ok', 'failed', 'not_applicable'] as const
export type VerifyStatus = (typeof VERIFY_STATUSES)[number]

export interface ProfileItem {
  id: number
  campaign_id: number
  kind: ItemKind
  name: string
  value: string | null
  config: Record<string, unknown>
  status: ItemStatus
  source: ItemSource
  rationale: string | null
  verify_status: VerifyStatus
  verify_detail: string | null
  verified_at: Date | null
  sort: number
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export const PROFILE_FIELDS = ['industry', 'vertical', 'description', 'icp', 'value_prop', 'newsletter_list', 'utm', 'kpis', 'setup_status'] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]
export type ProfilePatch = Partial<{
  industry: string | null
  vertical: string | null
  description: string | null
  icp: Icp
  value_prop: string | null
  newsletter_list: string | null
  utm: Utm
  kpis: Kpi[]
  setup_status: SetupStatus
}>

const SIGNAL_RULE_TYPES = ['tech_change', 'hiring', 'filing', 'page_change', 'review', 'funding', 'new_location', 'custom'] as const

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function str(field: string, v: unknown, max: number, required = false): string | null {
  if (v === null || v === undefined) {
    if (required) throw new ProfileError(`${field} is required.`)
    return null
  }
  if (typeof v !== 'string') throw new ProfileError(`${field} must be text.`)
  const s = v.trim()
  if (!s) {
    if (required) throw new ProfileError(`${field} is required.`)
    return null
  }
  if (s.length > max) throw new ProfileError(`${field} is too long (max ${max} characters).`)
  return s
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function parseIcp(v: unknown): Icp {
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new ProfileError('icp must be an object.')
  const b = v as Record<string, unknown>
  const allowed = ['business_types', 'size', 'geographies', 'roles', 'exclude']
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new ProfileError(`icp.${k} is not a known field (${allowed.join(', ')}).`)
  const strList = (k: string): string[] | undefined => {
    const x = b[k]
    if (x === undefined) return undefined
    if (!Array.isArray(x)) throw new ProfileError(`icp.${k} must be a list of text.`)
    return x.map((s, i) => {
      if (typeof s !== 'string') throw new ProfileError(`icp.${k}[${i}] must be text.`)
      const t = s.trim()
      if (t.length > 200) throw new ProfileError(`icp.${k}[${i}] is too long.`)
      return t
    }).filter(Boolean)
  }
  let size: IcpSize | undefined
  if (b.size !== undefined) {
    if (typeof b.size !== 'object' || b.size === null || Array.isArray(b.size)) throw new ProfileError('icp.size must be an object.')
    const sb = b.size as Record<string, unknown>
    const num = (k: string) => {
      const x = sb[k]
      if (x === undefined || x === null || x === '') return null
      const n = Number(x)
      if (!Number.isFinite(n) || n < 0) throw new ProfileError(`icp.size.${k} must be a non-negative number.`)
      return n
    }
    size = { employees_min: num('employees_min'), employees_max: num('employees_max'), revenue_min: num('revenue_min'), revenue_max: num('revenue_max') }
  }
  const out: Icp = {}
  const bt = strList('business_types'); if (bt) out.business_types = bt
  const geo = strList('geographies'); if (geo) out.geographies = geo
  const roles = strList('roles'); if (roles) out.roles = roles
  const exclude = strList('exclude'); if (exclude) out.exclude = exclude
  if (size) out.size = size
  return out
}

function parseUtm(v: unknown): Utm {
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new ProfileError('utm must be an object.')
  const b = v as Record<string, unknown>
  const allowed = ['source', 'medium', 'campaign', 'content_rule']
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new ProfileError(`utm.${k} is not a known field (${allowed.join(', ')}).`)
  const out: Utm = {}
  for (const k of allowed as (keyof Utm)[]) {
    if (b[k] === undefined) continue
    out[k] = str(`utm.${k}`, b[k], 120) as string | null
  }
  return out
}

function parseKpis(v: unknown): Kpi[] {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw new ProfileError('kpis must be a list.')
  return v.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new ProfileError(`kpis[${i}] must be an object.`)
    const b = x as Record<string, unknown>
    const metric = str('metric', b.metric, 80, true) as string
    const target = Number(b.target)
    if (!Number.isFinite(target)) throw new ProfileError(`kpis[${i}].target must be a number.`)
    const period = str('period', b.period, 40, true) as string
    return { metric, target, period }
  })
}

const SETUP_STATUSES: readonly SetupStatus[] = ['draft', 'suggested', 'reviewed', 'active']

/** Check a profile patch from the wizard, a server action or the ops API. Unknown keys refused. */
export function parseProfilePatch(body: unknown): ProfilePatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProfileError('Send the profile fields as JSON.')
  const b = body as Record<string, unknown>
  for (const k of Object.keys(b)) if (!(PROFILE_FIELDS as readonly string[]).includes(k)) throw new ProfileError(`${k} can't be set on a campaign profile.`)
  const out: ProfilePatch = {}
  if ('industry' in b) out.industry = str('industry', b.industry, 120)
  if ('vertical' in b) out.vertical = str('vertical', b.vertical, 120)
  if ('description' in b) out.description = str('description', b.description, 4000)
  if ('icp' in b) out.icp = parseIcp(b.icp)
  if ('value_prop' in b) out.value_prop = str('value_prop', b.value_prop, 2000)
  if ('newsletter_list' in b) out.newsletter_list = str('newsletter_list', b.newsletter_list, 200)
  if ('utm' in b) out.utm = parseUtm(b.utm)
  if ('kpis' in b) out.kpis = parseKpis(b.kpis)
  if ('setup_status' in b) {
    if (typeof b.setup_status !== 'string' || !SETUP_STATUSES.includes(b.setup_status as SetupStatus)) {
      throw new ProfileError(`setup_status must be one of: ${SETUP_STATUSES.join(', ')}.`)
    }
    out.setup_status = b.setup_status as SetupStatus
  }
  if (!Object.keys(out).length) throw new ProfileError('Nothing to change.')
  return out
}

/** Per-kind check of value/config, applied on add and on update. */
function checkItem(kind: ItemKind, value: string | null, config: Record<string, unknown>): void {
  if ((kind === 'feed' || kind === 'competitor') && value) {
    if (kind === 'feed' && !isHttpUrl(value)) throw new ProfileError('A feed value must be an http(s) URL.')
  }
  if (kind === 'competitor') {
    for (const k of ['newsroom_url', 'changelog_url', 'pricing_url', 'ads_library_url']) {
      const u = config[k]
      if (u !== undefined && u !== null && u !== '' && !(typeof u === 'string' && isHttpUrl(u))) {
        throw new ProfileError(`competitor config.${k} must be an http(s) URL.`)
      }
    }
  }
  if (kind === 'signal_rule') {
    const t = config.type
    if (typeof t !== 'string' || !SIGNAL_RULE_TYPES.includes(t as (typeof SIGNAL_RULE_TYPES)[number])) {
      throw new ProfileError(`signal_rule config.type must be one of: ${SIGNAL_RULE_TYPES.join(', ')}.`)
    }
  }
  if (kind === 'fingerprint') {
    const p = config.patterns
    if (!Array.isArray(p) || !p.length || !p.every((x) => typeof x === 'string' && x.trim())) {
      throw new ProfileError('fingerprint config.patterns must be a non-empty list of text patterns.')
    }
  }
}

export interface ItemInput {
  kind: ItemKind
  name: string
  value?: string | null
  config?: Record<string, unknown>
  status?: ItemStatus
  source?: ItemSource
  rationale?: string | null
  sort?: number
  verify_status?: VerifyStatus
  verify_detail?: string | null
}

function parseItemInput(v: unknown, i: number): Required<Pick<ItemInput, 'kind' | 'name'>> & ItemInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProfileError(`items[${i}] must be an object.`)
  const b = v as Record<string, unknown>
  if (typeof b.kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(b.kind)) {
    throw new ProfileError(`items[${i}].kind must be one of: ${ITEM_KINDS.join(', ')}.`)
  }
  const kind = b.kind as ItemKind
  const name = str('name', b.name, 200, true) as string
  const value = 'value' in b ? str('value', b.value, 2000) : null
  let config: Record<string, unknown> = {}
  if (b.config !== undefined && b.config !== null) {
    if (typeof b.config !== 'object' || Array.isArray(b.config)) throw new ProfileError(`items[${i}].config must be an object.`)
    config = b.config as Record<string, unknown>
  }
  let status: ItemStatus = 'approved'
  if ('status' in b) {
    if (typeof b.status !== 'string' || !(ITEM_STATUSES as readonly string[]).includes(b.status)) throw new ProfileError(`items[${i}].status must be one of: ${ITEM_STATUSES.join(', ')}.`)
    status = b.status as ItemStatus
  }
  let source: ItemSource = 'human'
  if ('source' in b) {
    if (typeof b.source !== 'string' || !(ITEM_SOURCES as readonly string[]).includes(b.source)) throw new ProfileError(`items[${i}].source must be one of: ${ITEM_SOURCES.join(', ')}.`)
    source = b.source as ItemSource
  }
  const rationale = 'rationale' in b ? str('rationale', b.rationale, 1000) : null
  const sort = 'sort' in b && b.sort != null ? Number(b.sort) : 100
  if (!Number.isFinite(sort)) throw new ProfileError(`items[${i}].sort must be a number.`)
  let verify_status: VerifyStatus | undefined
  if ('verify_status' in b) {
    if (typeof b.verify_status !== 'string' || !(VERIFY_STATUSES as readonly string[]).includes(b.verify_status)) throw new ProfileError(`items[${i}].verify_status must be one of: ${VERIFY_STATUSES.join(', ')}.`)
    verify_status = b.verify_status as VerifyStatus
  }
  const verify_detail = 'verify_detail' in b ? str('verify_detail', b.verify_detail, 1000) : undefined
  checkItem(kind, value, config)
  return { kind, name, value, config, status, source, rationale, sort, verify_status, verify_detail: verify_detail ?? undefined }
}

/** Same checks addItems uses, for validate/import. Does not write. */
export function parseProfileItem(v: unknown, index = 0): ItemInput {
  return parseItemInput(v, index)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PROFILE_COLS = 'campaign_id, industry, vertical, description, icp, value_prop, newsletter_list, utm, kpis, setup_status, ai_last_suggested_at, ai_model, created_by, updated_by, created_at, updated_at'
const ITEM_RETURNING = 'id, campaign_id, kind, name, value, config, status, source, rationale, verify_status, verify_detail, verified_at, sort, created_by, updated_by, created_at, updated_at'

function profileRow(r: Record<string, unknown>): CampaignProfile {
  return {
    campaign_id: Number(r.campaign_id),
    industry: (r.industry as string) ?? null,
    vertical: (r.vertical as string) ?? null,
    description: (r.description as string) ?? null,
    icp: (r.icp as Icp) ?? {},
    value_prop: (r.value_prop as string) ?? null,
    newsletter_list: (r.newsletter_list as string) ?? null,
    utm: (r.utm as Utm) ?? {},
    kpis: (r.kpis as Kpi[]) ?? [],
    setup_status: (r.setup_status as SetupStatus) ?? 'draft',
    ai_last_suggested_at: (r.ai_last_suggested_at as Date) ?? null,
    ai_model: (r.ai_model as string) ?? null,
    created_by: (r.created_by as string) ?? null,
    updated_by: (r.updated_by as string) ?? null,
    created_at: r.created_at as Date,
    updated_at: r.updated_at as Date,
  }
}

function itemRow(r: Record<string, unknown>): ProfileItem {
  return {
    id: Number(r.id),
    campaign_id: Number(r.campaign_id),
    kind: r.kind as ItemKind,
    name: r.name as string,
    value: (r.value as string) ?? null,
    config: (r.config as Record<string, unknown>) ?? {},
    status: r.status as ItemStatus,
    source: r.source as ItemSource,
    rationale: (r.rationale as string) ?? null,
    verify_status: (r.verify_status as VerifyStatus) ?? 'unchecked',
    verify_detail: (r.verify_detail as string) ?? null,
    verified_at: (r.verified_at as Date) ?? null,
    sort: Number(r.sort),
    created_by: (r.created_by as string) ?? null,
    updated_by: (r.updated_by as string) ?? null,
    created_at: r.created_at as Date,
    updated_at: r.updated_at as Date,
  }
}

/** An empty draft shape: used when a campaign has no profile row yet. Creates nothing. */
function emptyProfile(campaignId: number): CampaignProfile {
  return {
    campaign_id: campaignId, industry: null, vertical: null, description: null, icp: {}, value_prop: null,
    newsletter_list: null, utm: {}, kpis: [], setup_status: 'draft', ai_last_suggested_at: null, ai_model: null,
    created_by: null, updated_by: null, created_at: new Date(0), updated_at: new Date(0),
  }
}

export interface ProfileWithItems {
  profile: CampaignProfile
  items: Record<ItemKind, ProfileItem[]>
  exists: boolean
}

function groupedEmpty(): Record<ItemKind, ProfileItem[]> {
  return Object.fromEntries(ITEM_KINDS.map((k) => [k, [] as ProfileItem[]])) as unknown as Record<ItemKind, ProfileItem[]>
}

/**
 * Read a campaign's profile and its items, grouped by kind. Creates nothing:
 * a campaign with no row gets an empty draft shape back (setup_status
 * 'draft', every list empty) so the wizard can render step 1 immediately.
 */
export async function getProfile(db: Queryable, campaignId: number): Promise<ProfileWithItems> {
  const c = await db.query<{ id: number }>('select id from lp.campaigns where id = $1', [campaignId])
  if (!c.rows[0]) throw new ProfileError(`No campaign ${campaignId}.`, 404)
  const p = await db.query<Record<string, unknown>>(`select ${PROFILE_COLS} from lp.campaign_profiles where campaign_id = $1`, [campaignId])
  const items = await db.query<Record<string, unknown>>(
    `select ${ITEM_RETURNING}
     from lp.campaign_profile_items where campaign_id = $1 and status <> 'archived' order by kind, sort, lower(name)`,
    [campaignId],
  )
  const grouped = groupedEmpty()
  for (const r of items.rows) {
    const it = itemRow(r)
    grouped[it.kind].push(it)
  }
  return { profile: p.rows[0] ? profileRow(p.rows[0]) : emptyProfile(campaignId), items: grouped, exists: Boolean(p.rows[0]) }
}

/** Items of one kind, approved only — the function monitors/connectors/signal jobs call. */
export async function approvedItems(db: Queryable, campaignId: number, kind: ItemKind): Promise<ProfileItem[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select ${ITEM_RETURNING}
     from lp.campaign_profile_items where campaign_id = $1 and kind = $2 and status = 'approved' order by sort, lower(name)`,
    [campaignId, kind],
  )
  return rows.map(itemRow)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function fieldWord(k: ProfileField): string {
  return { industry: 'Industry', vertical: 'Vertical', description: 'Description', icp: 'ICP', value_prop: 'Value prop',
    newsletter_list: 'Newsletter list', utm: 'UTM', kpis: 'KPIs', setup_status: 'Setup status' }[k]
}
function showField(k: ProfileField, v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (k === 'icp' || k === 'utm' || k === 'kpis') return JSON.stringify(v)
  return String(v)
}

/** Validated partial update of the campaign_profiles row. Creates the row if it doesn't exist yet. */
export async function upsertProfile(db: Db, actor: string, campaignId: number, patch: ProfilePatch): Promise<CampaignProfile> {
  const p = parseProfilePatch(patch as unknown)
  return db.tx(async (q) => {
    const c = await q.query<{ id: number; name: string }>('select id, name from lp.campaigns where id = $1', [campaignId])
    if (!c.rows[0]) throw new ProfileError(`No campaign ${campaignId}.`, 404)
    const before = await q.query<Record<string, unknown>>(`select ${PROFILE_COLS} from lp.campaign_profiles where campaign_id = $1 for update`, [campaignId])
    const old = before.rows[0] ? profileRow(before.rows[0]) : emptyProfile(campaignId)
    const changed = (Object.keys(p) as ProfileField[]).filter((k) => JSON.stringify(p[k] ?? null) !== JSON.stringify((old as unknown as Record<string, unknown>)[k] ?? null))
    if (!changed.length) return old
    let row: Record<string, unknown>
    if (!before.rows[0]) {
      const { rows } = await q.query<Record<string, unknown>>(
        `insert into lp.campaign_profiles (campaign_id, industry, vertical, description, icp, value_prop, newsletter_list, utm, kpis, setup_status, created_by, updated_by)
         values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb), $6, $7, coalesce($8::jsonb, '{}'::jsonb), coalesce($9::jsonb, '[]'::jsonb), coalesce($10, 'draft'), $11, $11)
         returning ${PROFILE_COLS}`,
        [campaignId, p.industry ?? null, p.vertical ?? null, p.description ?? null, p.icp ? JSON.stringify(p.icp) : null,
         p.value_prop ?? null, p.newsletter_list ?? null, p.utm ? JSON.stringify(p.utm) : null, p.kpis ? JSON.stringify(p.kpis) : null,
         p.setup_status ?? null, actor],
      )
      row = rows[0]
    } else {
      const sets: string[] = []
      const vals: unknown[] = [campaignId]
      for (const k of changed) {
        vals.push(k === 'icp' || k === 'utm' || k === 'kpis' ? JSON.stringify(p[k]) : (p as Record<string, unknown>)[k])
        sets.push(`${k} = $${vals.length}${k === 'icp' || k === 'utm' || k === 'kpis' ? '::jsonb' : ''}`)
      }
      vals.push(actor)
      const { rows } = await q.query<Record<string, unknown>>(
        `update lp.campaign_profiles set ${sets.join(', ')}, updated_by = $${vals.length} where campaign_id = $1 returning ${PROFILE_COLS}`,
        vals,
      )
      row = rows[0]
    }
    const next = profileRow(row)
    for (const k of changed) {
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, $2, $3, $4, $5, $6)`,
        [campaignId, k, showField(k, (old as unknown as Record<string, unknown>)[k]), showField(k, (next as unknown as Record<string, unknown>)[k]), actor, 'ui'],
      )
    }
    await logEvent(q, {
      actor,
      kind: 'campaign_profile.updated',
      summary: `${actor} updated ${c.rows[0].name}'s profile: ${changed.map(fieldWord).join(', ')}`,
      entity_type: 'campaign_profile',
      entity_id: campaignId,
      data: { changes: changed },
    })
    return next
  }, actor)
}

export interface AddItemsResult {
  added: ProfileItem[]
  already: { kind: ItemKind; name: string }[]
}

/**
 * Add items in batch, deduping case-insensitively per (campaign, kind, name)
 * against any existing live (non-archived) item. An existing live item with
 * the same kind+name(ci) is left alone and reported in `already`, never
 * overwritten (use updateItem for that).
 */
export async function addItems(db: Db, actor: string, campaignId: number, inputs: unknown[], via: 'ui' | 'ops_api' | 'import' | 'copied' = 'ui'): Promise<AddItemsResult> {
  if (!Array.isArray(inputs) || !inputs.length) throw new ProfileError('items must be a non-empty list.')
  if (inputs.length > 500) throw new ProfileError('At most 500 items at a time.')
  const parsed = inputs.map((v, i) => parseItemInput(v, i))
  return db.tx(async (q) => {
    const c = await q.query<{ id: number }>('select id from lp.campaigns where id = $1', [campaignId])
    if (!c.rows[0]) throw new ProfileError(`No campaign ${campaignId}.`, 404)
    const added: ProfileItem[] = []
    const already: { kind: ItemKind; name: string }[] = []
    for (const it of parsed) {
      const existing = await q.query<{ id: number }>(
        `select id from lp.campaign_profile_items where campaign_id = $1 and kind = $2 and lower(name) = lower($3) and status <> 'archived'`,
        [campaignId, it.kind, it.name],
      )
      if (existing.rows[0]) {
        already.push({ kind: it.kind, name: it.name })
        continue
      }
      const { rows } = await q.query<Record<string, unknown>>(
        `insert into lp.campaign_profile_items (campaign_id, kind, name, value, config, status, source, rationale, verify_status, verify_detail, verified_at, sort, created_by, updated_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, coalesce($9, 'unchecked'), $10, case when $9 is not null then now() else null end, $11, $12, $12)
         returning ${ITEM_RETURNING}`,
        [campaignId, it.kind, it.name, it.value, JSON.stringify(it.config ?? {}), it.status, it.source, it.rationale, it.verify_status ?? null, it.verify_detail ?? null, it.sort, actor],
      )
      const row = itemRow(rows[0])
      added.push(row)
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, $2, null, $3, $4, $5)`,
        [campaignId, `item:${it.kind}:${it.name}`, `added (${it.source})`, actor, via],
      )
    }
    if (added.length) {
      await logEvent(q, {
        actor,
        kind: 'campaign_profile.items_added',
        summary: `${actor} added ${added.length} profile item${added.length === 1 ? '' : 's'} to campaign ${campaignId}${already.length ? ` (${already.length} already there)` : ''}`,
        entity_type: 'campaign_profile',
        entity_id: campaignId,
        data: { added: added.map((a) => ({ kind: a.kind, name: a.name, status: a.status })), already },
      })
    }
    return { added, already }
  }, actor)
}

export interface ItemPatch {
  name?: string
  value?: string | null
  config?: Record<string, unknown>
  rationale?: string | null
  sort?: number
}

/** Edit one item's own fields (not its status — use setItemStatus for that). */
export async function updateItem(db: Db, actor: string, itemId: number, patch: ItemPatch): Promise<ProfileItem> {
  return db.tx(async (q) => {
    const before = await q.query<Record<string, unknown>>(
      `select ${ITEM_RETURNING}
       from lp.campaign_profile_items where id = $1 for update`,
      [itemId],
    )
    if (!before.rows[0]) throw new ProfileError(`No profile item ${itemId}.`, 404)
    const old = itemRow(before.rows[0])
    const name = patch.name !== undefined ? (str('name', patch.name, 200, true) as string) : old.name
    const value = patch.value !== undefined ? str('value', patch.value, 2000) : old.value
    const config = patch.config !== undefined ? patch.config : old.config
    checkItem(old.kind, value, config)
    const rationale = patch.rationale !== undefined ? str('rationale', patch.rationale, 1000) : old.rationale
    const sort = patch.sort !== undefined ? Number(patch.sort) : old.sort
    if (!Number.isFinite(sort)) throw new ProfileError('sort must be a number.')
    if (name !== old.name) {
      const dup = await q.query<{ id: number }>(
        `select id from lp.campaign_profile_items where campaign_id = $1 and kind = $2 and lower(name) = lower($3) and status <> 'archived' and id <> $4`,
        [old.campaign_id, old.kind, name, itemId],
      )
      if (dup.rows[0]) throw new ProfileError(`"${name}" already exists for this campaign and kind.`, 409)
    }
    const { rows } = await q.query<Record<string, unknown>>(
      `update lp.campaign_profile_items set name = $2, value = $3, config = $4::jsonb, rationale = $5, sort = $6, updated_by = $7
       where id = $1
       returning ${ITEM_RETURNING}`,
      [itemId, name, value, JSON.stringify(config ?? {}), rationale, sort, actor],
    )
    const next = itemRow(rows[0])
    if (name !== old.name || value !== old.value || JSON.stringify(config) !== JSON.stringify(old.config)) {
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, $2, $3, $4, $5, $6)`,
        [old.campaign_id, `item:${old.kind}:${old.name}`, `${old.name}${old.value ? ` (${old.value})` : ''}`, `${name}${value ? ` (${value})` : ''}`, actor, 'ui'],
      )
    }
    return next
  }, actor)
}

/** Approve / reject / archive items in batch. */
export async function setItemStatus(db: Db, actor: string, ids: number[], status: ItemStatus, via: 'ui' | 'ops_api' = 'ui'): Promise<ProfileItem[]> {
  if (!Array.isArray(ids) || !ids.length) throw new ProfileError('ids must be a non-empty list.')
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) throw new ProfileError(`status must be one of: ${ITEM_STATUSES.join(', ')}.`)
  return db.tx(async (q) => {
    const out: ProfileItem[] = []
    for (const id of ids) {
      const before = await q.query<Record<string, unknown>>(
        `select ${ITEM_RETURNING}
         from lp.campaign_profile_items where id = $1 for update`,
        [id],
      )
      if (!before.rows[0]) throw new ProfileError(`No profile item ${id}.`, 404)
      const old = itemRow(before.rows[0])
      if (old.status === status) {
        out.push(old)
        continue
      }
      const { rows } = await q.query<Record<string, unknown>>(
        `update lp.campaign_profile_items set status = $2, updated_by = $3
         where id = $1
         returning ${ITEM_RETURNING}`,
        [id, status, actor],
      )
      const next = itemRow(rows[0])
      out.push(next)
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, $2, $3, $4, $5, $6)`,
        [old.campaign_id, `item:${old.kind}:${old.name}`, old.status, status, actor, via],
      )
    }
    await logEvent(q, {
      actor,
      kind: 'campaign_profile.items_status',
      summary: `${actor} set ${out.length} profile item${out.length === 1 ? '' : 's'} to ${status}`,
      entity_type: 'campaign_profile',
      entity_id: out[0]?.campaign_id ?? null,
      data: { ids, status },
    })
    return out
  }, actor)
}

export interface VerifyWrite {
  status: VerifyStatus
  detail: string | null
}

/** Record one item's verify result (verify.ts calls this after checking a feed/URL/forum/etc). */
export async function setItemVerify(db: Db, actor: string, itemId: number, v: VerifyWrite): Promise<ProfileItem> {
  if (!(VERIFY_STATUSES as readonly string[]).includes(v.status)) throw new ProfileError(`verify status must be one of: ${VERIFY_STATUSES.join(', ')}.`)
  return db.tx(async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `update lp.campaign_profile_items set verify_status = $2, verify_detail = $3, verified_at = now(), updated_by = $4
       where id = $1
       returning ${ITEM_RETURNING}`,
      [itemId, v.status, v.detail, actor],
    )
    if (!rows[0]) throw new ProfileError(`No profile item ${itemId}.`, 404)
    return itemRow(rows[0])
  }, actor)
}

export interface CopyResult {
  profile: CampaignProfile | null
  items_copied: number
}

/** Copy a profile (scalars + approved/suggested items, not rejected/archived) from one campaign to another, source 'copied'. */
export async function copyProfile(db: Db, actor: string, fromCampaign: number, toCampaign: number): Promise<CopyResult> {
  if (fromCampaign === toCampaign) throw new ProfileError('Source and destination campaigns must differ.')
  return db.tx(async (q) => {
    const cs = await q.query<{ id: number }>('select id from lp.campaigns where id = any($1)', [[fromCampaign, toCampaign]])
    if (cs.rows.length < 2) throw new ProfileError('Both campaigns must exist.', 404)
    const src = await q.query<Record<string, unknown>>(`select ${PROFILE_COLS} from lp.campaign_profiles where campaign_id = $1`, [fromCampaign])
    let profile: CampaignProfile | null = null
    if (src.rows[0]) {
      const s = profileRow(src.rows[0])
      const dest = await q.query<{ campaign_id: number }>('select campaign_id from lp.campaign_profiles where campaign_id = $1 for update', [toCampaign])
      if (dest.rows[0]) {
        const { rows } = await q.query<Record<string, unknown>>(
          `update lp.campaign_profiles set industry=$2, vertical=$3, description=$4, icp=$5::jsonb, value_prop=$6, newsletter_list=$7, utm=$8::jsonb, kpis=$9::jsonb, updated_by=$10
           where campaign_id=$1 returning ${PROFILE_COLS}`,
          [toCampaign, s.industry, s.vertical, s.description, JSON.stringify(s.icp), s.value_prop, s.newsletter_list, JSON.stringify(s.utm), JSON.stringify(s.kpis), actor],
        )
        profile = profileRow(rows[0])
      } else {
        const { rows } = await q.query<Record<string, unknown>>(
          `insert into lp.campaign_profiles (campaign_id, industry, vertical, description, icp, value_prop, newsletter_list, utm, kpis, setup_status, created_by, updated_by)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, 'draft', $10, $10) returning ${PROFILE_COLS}`,
          [toCampaign, s.industry, s.vertical, s.description, JSON.stringify(s.icp), s.value_prop, s.newsletter_list, JSON.stringify(s.utm), JSON.stringify(s.kpis), actor],
        )
        profile = profileRow(rows[0])
      }
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, 'copied_from', null, $2, $3, 'ui')`,
        [toCampaign, String(fromCampaign), actor],
      )
    }
    const items = await q.query<Record<string, unknown>>(
      `select kind, name, value, config, rationale, sort, status from lp.campaign_profile_items where campaign_id = $1 and status <> 'archived'`,
      [fromCampaign],
    )
    let copied = 0
    for (const r of items.rows) {
      const kind = r.kind as ItemKind
      const name = r.name as string
      const existing = await q.query<{ id: number }>(
        `select id from lp.campaign_profile_items where campaign_id = $1 and kind = $2 and lower(name) = lower($3) and status <> 'archived'`,
        [toCampaign, kind, name],
      )
      if (existing.rows[0]) continue
      await q.query(
        `insert into lp.campaign_profile_items (campaign_id, kind, name, value, config, status, source, rationale, sort, created_by, updated_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'copied', $7, $8, $9, $9)`,
        [toCampaign, kind, name, r.value, JSON.stringify(r.config ?? {}), r.status, r.rationale, r.sort, actor],
      )
      copied += 1
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign_profile', $1, $2, null, $3, $4, 'ui')`,
        [toCampaign, `item:${kind}:${name}`, `copied from campaign ${fromCampaign}`, actor],
      )
    }
    await logEvent(q, {
      actor,
      kind: 'campaign_profile.copied',
      summary: `${actor} copied the profile from campaign ${fromCampaign} to campaign ${toCampaign} (${copied} item${copied === 1 ? '' : 's'})`,
      entity_type: 'campaign_profile',
      entity_id: toCampaign,
      data: { from: fromCampaign, items_copied: copied },
    })
    return { profile, items_copied: copied }
  }, actor)
}
