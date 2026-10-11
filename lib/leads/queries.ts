/**
 * Read + write paths for the Leads, Overview and lead-detail screens.
 *
 * Every user-supplied value travels as a bind parameter ($n). The only SQL
 * text composed at runtime comes from fixed fragments chosen from whitelists
 * (sort columns, view predicates), never from input.
 */
import type { Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { STAGES, type Stage, type VerificationStatus } from './types'
import { NONE, PAGE_SIZE, STAGE_LABELS, type LeadFilters, type LeadQuery, type LeadView, type SortKey } from './filters'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
export interface LeadListRow {
  id: number
  name: string
  segment: string
  website: string | null
  website_domain: string | null
  city: string | null
  state: string | null
  owner_name: string | null
  stage: Stage
  research_status: string
  updated_at: Date
  primary_contact_id: number | null
  primary_email: string | null
  primary_verification: VerificationStatus | null
  contact_count: number
  unverified_ids: number[]
  campaign_name: string | null
  last_event_type: string | null
  last_event_at: Date | null
}

export interface LeadPage {
  rows: LeadListRow[]
  total: number
  page: number
  pageSize: number
  pages: number
}

// ---------------------------------------------------------------------------
// WHERE builder
// ---------------------------------------------------------------------------
export class Params {
  values: unknown[] = []
  add(v: unknown): string {
    this.values.push(v)
    return `$${this.values.length}`
  }
}

/** Touches that belong to company c (directly, or through one of its contacts). */
const TOUCH_OF_C = `(t.company_id = c.id or t.contact_id in (select x.id from lp.contacts x where x.company_id = c.id))`

/**
 * Every touch resolved to its company (directly, or through its contact), as a
 * relation. Touches are few next to companies (hundreds vs tens of thousands),
 * so building this once beats probing touches per company.
 */
export const TOUCH_COMPANY_REL = `(select coalesce(t.company_id, x.company_id) as co, t.campaign_name, t.event_type, t.occurred_at, t.id
     from lp.campaign_touches t left join lp.contacts x on x.id = t.contact_id
    where coalesce(t.company_id, x.company_id) is not null)`

/** company -> the latest campaign name it was touched by (companies never in a named campaign are absent). */
export const LATEST_CAMPAIGN_REL = `(select distinct on (tc.co) tc.co, tc.campaign_name from ${TOUCH_COMPANY_REL} tc
    where tc.campaign_name is not null order by tc.co, tc.occurred_at desc, tc.id desc)`

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** View predicates: fixed SQL, no input. */
const VIEW_WHERE: Partial<Record<LeadView, string>> = {
  research: `c.research_status in ('needs_research', 'failed')`,
  verify: `exists (select 1 from lp.contacts v where v.company_id = c.id and v.email_norm is not null and v.verification_status = 'unverified')`,
}

/**
 * Merge (0026) adds companies.merged_into / contacts.merged_into. Previews never
 * run migrations, so a preview deployment of a PR that lands after this one can
 * still be missing the column -- check once per db connection and cache a `true`
 * (a migration never un-applies) so the existing Leads screens keep working
 * instead of throwing "column ... does not exist".
 */
let mergedIntoReady: boolean | null = null
export async function hasMergedIntoColumn(db: Queryable): Promise<boolean> {
  if (mergedIntoReady) return true
  try {
    const { rows } = await db.query<{ e: boolean }>(
      `select exists (select 1 from information_schema.columns
         where table_schema = 'lp' and table_name = 'companies' and column_name = 'merged_into') as e`,
    )
    mergedIntoReady = Boolean(rows[0]?.e)
  } catch {
    mergedIntoReady = false
  }
  return mergedIntoReady
}

export function buildLeadWhere(f: LeadFilters, view: LeadView, p: Params, mergedReady = true): string {
  const w: string[] = mergedReady ? [`c.merged_into is null`] : []
  if (f.q) {
    const like = p.add(`%${escapeLike(f.q.toLowerCase())}%`)
    w.push(`(lower(c.name) like ${like} or c.website_domain like ${like} or lower(coalesce(c.city, '')) like ${like}
      or lower(coalesce(c.owner_name, '')) like ${like}
      or exists (select 1 from lp.contacts qc where qc.company_id = c.id and qc.email_norm like ${like}))`)
  }
  if (f.state === NONE) w.push(`nullif(trim(c.state), '') is null`)
  else if (f.state) w.push(`upper(c.state) = ${p.add(f.state.toUpperCase())}`)
  if (f.stage) w.push(`c.stage = ${p.add(f.stage)}`)
  if (f.segment) w.push(`c.segment = ${p.add(f.segment)}`)
  if (f.verification)
    w.push(`exists (select 1 from lp.contacts vc where vc.company_id = c.id and vc.email_norm is not null and vc.verification_status = ${p.add(f.verification)})`)
  if (f.hasEmail !== undefined)
    w.push(`${f.hasEmail ? '' : 'not '}exists (select 1 from lp.contacts ec where ec.company_id = c.id and ec.email_norm is not null)`)
  if (f.ownerKnown !== undefined) w.push(f.ownerKnown ? `nullif(trim(c.owner_name), '') is not null` : `nullif(trim(c.owner_name), '') is null`)
  if (f.job !== undefined)
    w.push(`exists (select 1 from lp.sources js where js.company_id = c.id and js.kind = 'engine' and js.source_ref = ${p.add(`find_leads:${f.job}`)})`)
  if (f.campaign === NONE) w.push(`c.id not in (select lc.co from ${LATEST_CAMPAIGN_REL} lc)`)
  else if (f.campaign) w.push(`c.id in (select lc.co from ${LATEST_CAMPAIGN_REL} lc where lc.campaign_name = ${p.add(f.campaign)})`)
  const vw = VIEW_WHERE[view]
  if (vw) w.push(vw)
  return w.length ? `where ${w.join('\n  and ')}` : ''
}

// ---------------------------------------------------------------------------
// The lead row select (shared by table, kanban, groups)
// ---------------------------------------------------------------------------
function leadSelect(where: string, keySql?: string, keyJoin = '', from = 'lp.companies c'): string {
  return `select ${keySql ? `${keySql} as k, ` : ''}c.id, c.name, c.segment, c.website, c.website_domain, c.city, c.state, c.owner_name,
       c.stage, c.research_status, c.updated_at,
       pc.id as primary_contact_id, pc.email as primary_email, pc.verification_status as primary_verification,
       coalesce(cc.n, 0) as contact_count, coalesce(cc.unverified_ids, '{}') as unverified_ids,
       lt.campaign_name, lt.event_type as last_event_type, lt.occurred_at as last_event_at
  from ${from}
  ${keyJoin}
  left join lateral (
    select ct.id, ct.email, ct.verification_status from lp.contacts ct
     where ct.company_id = c.id and ct.email_norm is not null
     order by (ct.verification_status = 'valid') desc, coalesce(ct.is_role_address, false), ct.id
     limit 1) pc on true
  left join lateral (
    select count(*)::int as n,
           array_agg(ct.id::int order by ct.id) filter (where ct.verification_status = 'unverified') as unverified_ids
      from lp.contacts ct where ct.company_id = c.id and ct.email_norm is not null) cc on true
  left join lateral (
    select t.campaign_name, t.event_type, t.occurred_at from lp.campaign_touches t
     where ${TOUCH_OF_C}
     order by t.occurred_at desc, t.id desc limit 1) lt on true
  ${where}`
}

function SORT_SQL_STAGE(col: string): string {
  return `array_position(array[${STAGES.map((s) => `'${s}'`).join(',')}]::text[], ${col})`
}

/** Full list rows for a known, small set of company ids, newest first. */
export async function leadRowsByIds(db: Queryable, ids: number[]): Promise<LeadListRow[]> {
  if (!ids.length) return []
  const { rows } = await db.query<LeadListRow>(
    `select * from (${leadSelect('where c.id = any($1::bigint[])')}) l order by l.updated_at desc, l.id desc`,
    [ids],
  )
  return rows.map(normalizeRow)
}

const SORT_SQL: Record<SortKey, string> = {
  name: 'lower(name)',
  city: 'lower(city)',
  state: 'upper(state)',
  stage: SORT_SQL_STAGE('stage'),
  email: 'primary_email',
  verification: 'primary_verification',
  campaign: 'lower(campaign_name)',
  updated: 'updated_at',
}

function normalizeRow(r: LeadListRow): LeadListRow {
  return { ...r, unverified_ids: (r.unverified_ids ?? []).map(Number) }
}

/** Sorts that only need the company row: page first, then compute the extras for 50 rows. */
const COMPANY_SORT: Partial<Record<SortKey, string>> = {
  name: 'lower(c.name)',
  city: 'lower(c.city)',
  state: 'upper(c.state)',
  stage: SORT_SQL_STAGE('c.stage'),
  updated: 'c.updated_at',
}

export async function listLeads(db: Queryable, q: LeadQuery): Promise<LeadPage> {
  const p = new Params()
  const where = buildLeadWhere(q.filters, q.view, p, await hasMergedIntoColumn(db))
  const countRes = await db.query<{ n: number }>(`select count(*)::int as n from lp.companies c ${where}`, p.values)
  const total = Number(countRes.rows[0]?.n ?? 0)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(q.page, pages)
  const dir = q.dir === 'asc' ? 'asc' : 'desc'
  const order = `${SORT_SQL[q.sort]} ${dir} nulls last, id ${dir}`
  const lim = p.add(PAGE_SIZE)
  const off = p.add((page - 1) * PAGE_SIZE)
  const companySort = COMPANY_SORT[q.sort]
  const sql = companySort
    ? // Page the companies first, then join contacts/touches for just this page.
      `select * from (${leadSelect('', undefined, '', `(select c.* from lp.companies c ${where}
          order by ${companySort} ${dir} nulls last, c.id ${dir} limit ${lim} offset ${off}) c`)}) l order by ${order}`
    : `select * from (${leadSelect(where)}) l order by ${order} limit ${lim} offset ${off}`
  const { rows } = await db.query<LeadListRow>(sql, p.values)
  return { rows: rows.map(normalizeRow), total, page, pageSize: PAGE_SIZE, pages }
}

// ---------------------------------------------------------------------------
// Kanban: per stage, the count and the newest cards
// ---------------------------------------------------------------------------
export interface KanbanColumn {
  stage: Stage
  label: string
  count: number
  cards: LeadListRow[]
}

export async function kanbanLeads(db: Queryable, f: LeadFilters, perColumn = 25): Promise<KanbanColumn[]> {
  const p = new Params()
  const where = buildLeadWhere(f, 'kanban', p, await hasMergedIntoColumn(db))
  const counts = await db.query<{ stage: Stage; n: number }>(
    `select c.stage, count(*)::int as n from lp.companies c ${where} group by c.stage`,
    p.values,
  )
  const lim = p.add(perColumn)
  // Pick the newest cards per stage from companies alone, then build just those rows
  // (two cheap queries; one combined query gets a huge row estimate and pays for JIT).
  const picked = await db.query<{ id: number }>(
    `select id from (select c.id, row_number() over (partition by c.stage order by c.updated_at desc, c.id desc) as rn
       from lp.companies c ${where}) z where z.rn <= ${lim}`,
    p.values,
  )
  const rows = await leadRowsByIds(db, picked.rows.map((r) => Number(r.id)))
  const byStage = new Map(counts.rows.map((r) => [r.stage, Number(r.n)]))
  return STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: byStage.get(stage) ?? 0,
    cards: rows.filter((r) => r.stage === stage).map(normalizeRow),
  }))
}

// ---------------------------------------------------------------------------
// Groups: by campaign and by state, with counts per stage
// ---------------------------------------------------------------------------
export interface LeadGroup {
  /** Campaign name or 2-letter state; null = "no campaign" / "no state". */
  key: string | null
  total: number
  byStage: Partial<Record<Stage, number>>
  /** Contacts in the group whose email is still unverified. */
  unverified: number
  sample: LeadListRow[]
}

async function groupLeads(
  db: Queryable,
  f: LeadFilters,
  view: LeadView,
  keySql: string,
  keyJoin: string,
  sampleSize: number,
): Promise<LeadGroup[]> {
  const p = new Params()
  const where = buildLeadWhere(f, view, p, await hasMergedIntoColumn(db))
  const agg = await db.query<{ k: string | null; stage: Stage; n: number; unverified: number }>(
    `select ${keySql} as k, c.stage, count(*)::int as n, coalesce(sum(u.n), 0)::int as unverified
       from lp.companies c
       ${keyJoin}
       left join (select company_id, count(*) as n from lp.contacts
                   where email_norm is not null and verification_status = 'unverified' group by company_id) u on u.company_id = c.id
       ${where} group by 1, 2`,
    p.values,
  )
  const groups = new Map<string | null, LeadGroup>()
  for (const r of agg.rows) {
    const g = groups.get(r.k) ?? { key: r.k, total: 0, byStage: {}, unverified: 0, sample: [] }
    g.total += Number(r.n)
    g.unverified += Number(r.unverified)
    g.byStage[r.stage] = (g.byStage[r.stage] ?? 0) + Number(r.n)
    groups.set(r.k, g)
  }
  if (sampleSize > 0 && groups.size) {
    const lim = p.add(sampleSize)
    // Newest few companies per group first, then build just those rows.
    const picked = await db.query<{ id: number; k: string | null }>(
      `select id, k from (select c.id, ${keySql} as k, row_number() over (partition by ${keySql} order by c.updated_at desc, c.id desc) as rn
         from lp.companies c ${keyJoin} ${where}) z where z.rn <= ${lim}`,
      p.values,
    )
    const keyOf = new Map(picked.rows.map((r) => [Number(r.id), r.k]))
    for (const r of await leadRowsByIds(db, [...keyOf.keys()])) groups.get(keyOf.get(r.id) ?? null)?.sample.push(r)
    for (const g of groups.values()) g.sample.sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
  }
  // Biggest first; the "none" bucket last.
  return [...groups.values()].sort((a, b) => (a.key === null ? 1 : b.key === null ? -1 : b.total - a.total || String(a.key).localeCompare(String(b.key))))
}

export function campaignGroups(db: Queryable, f: LeadFilters): Promise<LeadGroup[]> {
  return groupLeads(db, f, 'campaign', 'lc.campaign_name', `left join ${LATEST_CAMPAIGN_REL} lc on lc.co = c.id`, 5)
}

export function regionGroups(db: Queryable, f: LeadFilters): Promise<LeadGroup[]> {
  return groupLeads(db, f, 'region', `nullif(upper(trim(c.state)), '')`, '', 0)
}

// ---------------------------------------------------------------------------
// Stage change (bulk), as one actor, with an event
// ---------------------------------------------------------------------------
export interface StageChangeResult {
  updated: number
  unchanged: number
  missing: number
}

export async function setStage(
  db: { tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> },
  companyIds: number[],
  stage: Stage,
  actor: string,
): Promise<StageChangeResult> {
  const ids = [...new Set(companyIds)]
  return db.tx(async (q) => {
    const found = await q.query<{ id: number; name: string; stage: Stage }>(
      `select id, name, stage from lp.companies where id = any($1::bigint[]) for update`,
      [ids],
    )
    const toChange = found.rows.filter((r) => r.stage !== stage)
    if (toChange.length) {
      await q.query(`update lp.companies set stage = $1 where id = any($2::bigint[])`, [stage, toChange.map((r) => r.id)])
      const who = await actorName(q, actor)
      const label = STAGE_LABELS[stage]
      const summary =
        toChange.length === 1
          ? `${who} moved ${toChange[0].name} to ${label}`
          : `${who} moved ${toChange.length} leads to ${label}`
      await logEvent(q, {
        actor,
        kind: 'lead.stage_set',
        summary,
        entity_type: toChange.length === 1 ? 'company' : null,
        entity_id: toChange.length === 1 ? toChange[0].id : null,
        data: { stage, company_ids: toChange.map((r) => r.id), from: Object.fromEntries(toChange.map((r) => [r.id, r.stage])) },
      })
    }
    return { updated: toChange.length, unchanged: found.rows.length - toChange.length, missing: ids.length - found.rows.length }
  }, actor)
}

export async function actorName(q: Queryable, id: string): Promise<string> {
  const { rows } = await q.query<{ display_name: string }>(`select display_name from lp.actors where id = $1`, [id])
  return rows[0]?.display_name ?? id
}

// ---------------------------------------------------------------------------
// Facets for the filter bar (only values that exist in rows)
// ---------------------------------------------------------------------------
export interface LeadFacets {
  states: string[]
  campaigns: string[]
  total: number
}

export async function leadFacets(db: Queryable): Promise<LeadFacets> {
  const mergedReady = await hasMergedIntoColumn(db)
  const mergedAnd = mergedReady ? 'merged_into is null and ' : ''
  const mergedWhere = mergedReady ? 'where merged_into is null' : ''
  const [states, campaigns, total] = await Promise.all([
    db.query<{ s: string }>(`select distinct upper(trim(state)) as s from lp.companies where ${mergedAnd}nullif(trim(state), '') is not null order by 1`),
    db.query<{ s: string }>(`select distinct campaign_name as s from lp.campaign_touches where campaign_name is not null order by 1 limit 200`),
    db.query<{ n: number }>(`select count(*)::int as n from lp.companies ${mergedWhere}`),
  ])
  return { states: states.rows.map((r) => r.s), campaigns: campaigns.rows.map((r) => r.s), total: Number(total.rows[0]?.n ?? 0) }
}
