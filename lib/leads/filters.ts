/**
 * The Leads screen's URL contract: ?view=…&q=…&state=…&page=… -> a typed query.
 * Pure (no DB, no React) so the page, the client table and the tests share it.
 */
import { STAGES, VERIFICATION_STATUSES, type Stage, type VerificationStatus } from './types'

export const LEAD_VIEWS = ['table', 'kanban', 'campaign', 'region', 'research', 'verify'] as const
export type LeadView = (typeof LEAD_VIEWS)[number]

export const VIEW_LABELS: Record<LeadView, string> = {
  table: 'Table',
  kanban: 'By stage',
  campaign: 'By campaign',
  region: 'By state',
  research: 'Needs research',
  verify: 'Needs verification',
}

/**
 * A segment/pool is any slug in lp.pools (lib/pools/store.ts) — campaign-agnostic.
 * SEGMENT_LABELS below is a best-effort label map for the four original pools,
 * used only where there is no DB round trip; real labels come from lp.pools.
 */
export type Segment = string
export const SEGMENT_LABELS: Record<string, string> = { jeweler: 'Jewelers', ai_agency: 'AI agencies', ai_builder: 'AI builders', other: 'Other' }
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,40}$/

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'New',
  researched: 'Researched',
  ready: 'Ready',
  in_campaign: 'In campaign',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  meeting: 'Meeting',
  won: 'Won',
  lost: 'Lost',
  do_not_contact: 'Do not contact',
}

export const SORT_KEYS = ['name', 'city', 'state', 'stage', 'email', 'verification', 'campaign', 'updated'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export const PAGE_SIZE = 50
/** Sentinel for "no campaign" / "no state" groups in URLs. */
export const NONE = '__none'

export interface LeadFilters {
  q?: string
  state?: string
  stage?: Stage
  segment?: Segment
  verification?: VerificationStatus
  hasEmail?: boolean
  ownerKnown?: boolean
  /** Has a verified, sendable email not yet in a campaign: the Overview "Ready to send" tile. See READY_CONTACT_SQL. */
  ready?: boolean
  /** Has any Instantly activity (a campaign_touches row): the Overview "In campaigns" tile. */
  touched?: boolean
  /** lp.tasks id of a Find-leads job: companies with lp.sources kind='engine', source_ref='find_leads:<id>'. */
  job?: number
  /** Latest campaign name, or NONE. */
  campaign?: string
  /**
   * Advanced filters (plan 2.5): restrict to exactly these company ids, computed
   * by the page from a saved segment (?seg=) or an ad-hoc definition (?f=) --
   * see decodeAdvancedFilter below. NOT part of the LeadFilters URL contract
   * (parseLeadQuery never sets it, leadQueryToParams never serializes it): the
   * page computes it and spreads it onto filters before calling a query
   * function, same as any other in-memory narrowing.
   */
  companyIds?: number[] | null
}

export interface LeadQuery {
  view: LeadView
  filters: LeadFilters
  sort: SortKey
  dir: 'asc' | 'desc'
  page: number
}

type Params = Record<string, string | string[] | undefined>

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  const t = s?.trim()
  return t ? t : undefined
}

function oneOf<T extends string>(v: string | undefined, list: readonly T[]): T | undefined {
  return v && (list as readonly string[]).includes(v) ? (v as T) : undefined
}

function yesNo(v: string | undefined): boolean | undefined {
  if (v === 'yes') return true
  if (v === 'no') return false
  return undefined
}

/** Newest first for 'updated'; A→Z for everything else. */
export function defaultDir(sort: SortKey): 'asc' | 'desc' {
  return sort === 'updated' ? 'desc' : 'asc'
}

export function parseLeadQuery(p: Params): LeadQuery {
  const jobRaw = one(p.job)
  const job = jobRaw && /^\d{1,15}$/.test(jobRaw) ? Number(jobRaw) : undefined
  const state = one(p.state)
  const pageRaw = Number(one(p.page) ?? '1')
  const filters: LeadFilters = {
    q: one(p.q)?.slice(0, 200),
    state: state === NONE ? NONE : state && /^[A-Za-z]{2,3}$/.test(state) ? state.toUpperCase() : undefined,
    stage: oneOf(one(p.stage), STAGES),
    segment: (() => { const s = one(p.segment); return s && SEGMENT_RE.test(s) ? s : undefined })(),
    verification: oneOf(one(p.verification), VERIFICATION_STATUSES),
    hasEmail: yesNo(one(p.email)),
    ownerKnown: yesNo(one(p.owner)),
    ready: yesNo(one(p.ready)),
    touched: yesNo(one(p.touched)),
    job,
    campaign: one(p.campaign)?.slice(0, 300),
  }
  const sort = oneOf(one(p.sort), SORT_KEYS) ?? 'updated'
  const dirRaw = one(p.dir)
  return {
    view: oneOf(one(p.view), LEAD_VIEWS) ?? 'table',
    filters,
    sort,
    dir: dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : defaultDir(sort),
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(Math.floor(pageRaw), 100000) : 1,
  }
}

/** Back to URL params (only what differs from defaults), for links that keep the current filters. */
export function leadQueryToParams(q: LeadQuery): URLSearchParams {
  const u = new URLSearchParams()
  if (q.view !== 'table') u.set('view', q.view)
  const f = q.filters
  if (f.q) u.set('q', f.q)
  if (f.state) u.set('state', f.state)
  if (f.stage) u.set('stage', f.stage)
  if (f.segment) u.set('segment', f.segment)
  if (f.verification) u.set('verification', f.verification)
  if (f.hasEmail !== undefined) u.set('email', f.hasEmail ? 'yes' : 'no')
  if (f.ownerKnown !== undefined) u.set('owner', f.ownerKnown ? 'yes' : 'no')
  if (f.ready !== undefined) u.set('ready', f.ready ? 'yes' : 'no')
  if (f.touched !== undefined) u.set('touched', f.touched ? 'yes' : 'no')
  if (f.job !== undefined) u.set('job', String(f.job))
  if (f.campaign) u.set('campaign', f.campaign)
  if (q.sort !== 'updated') u.set('sort', q.sort)
  if (q.dir !== defaultDir(q.sort)) u.set('dir', q.dir)
  if (q.page > 1) u.set('page', String(q.page))
  return u
}

/** A /leads href from the current query with some parts changed. Page resets unless set. */
export function leadsHref(q: LeadQuery, patch: Partial<Omit<LeadQuery, 'filters'>> & { filters?: Partial<LeadFilters> } = {}): string {
  const next: LeadQuery = {
    ...q,
    ...patch,
    filters: { ...q.filters, ...(patch.filters ?? {}) },
    page: patch.page ?? 1,
  }
  const s = leadQueryToParams(next).toString()
  return s ? `/leads?${s}` : '/leads'
}

export function activeFilterCount(f: LeadFilters): number {
  return Object.entries(f).filter(([k, v]) => k !== 'companyIds' && v !== undefined && v !== '').length
}

// -----------------------------------------------------------------------
// Advanced filters (plan 2.5): the drawer's OWN params, ?seg= and ?f=.
// Independent of the LeadFilters contract above -- parseLeadQuery and
// leadQueryToParams never read or write these, so round-tripping an old
// /leads URL through them is unaffected by anything below.
// -----------------------------------------------------------------------
import type { SegmentDefinition } from '../segments/definition'
import { validateDefinition } from '../segments/definition'

/** A saved segment id from ?seg=, or null (absent / not a positive integer). */
export function parseSegParam(v: string | string[] | undefined): number | null {
  const s = one(v)
  if (!s || !/^\d{1,15}$/.test(s)) return null
  const n = Number(s)
  return n > 0 ? n : null
}

/** An ad-hoc segment definition for ?f=, URL-safe JSON. Re-validated on decode (never trust the URL blindly). */
export function encodeAdvancedFilter(def: SegmentDefinition): string {
  return encodeURIComponent(JSON.stringify(def))
}

export function decodeAdvancedFilter(v: string | string[] | undefined): SegmentDefinition | null {
  const raw = one(v)
  if (!raw) return null
  try {
    return validateDefinition(JSON.parse(decodeURIComponent(raw)))
  } catch {
    return null
  }
}
