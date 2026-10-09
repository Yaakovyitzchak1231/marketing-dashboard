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

export const SEGMENTS = ['jeweler', 'ai_agency', 'ai_builder', 'other'] as const
export type Segment = (typeof SEGMENTS)[number]
export const SEGMENT_LABELS: Record<Segment, string> = { jeweler: 'Jewelers', ai_agency: 'AI agencies', ai_builder: 'AI builders', other: 'Other' }

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
  /** lp.tasks id of a Find-leads job: companies with lp.sources kind='engine', source_ref='find_leads:<id>'. */
  job?: number
  /** Latest campaign name, or NONE. */
  campaign?: string
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
    segment: oneOf(one(p.segment), SEGMENTS),
    verification: oneOf(one(p.verification), VERIFICATION_STATUSES),
    hasEmail: yesNo(one(p.email)),
    ownerKnown: yesNo(one(p.owner)),
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
  return Object.values(f).filter((v) => v !== undefined && v !== '').length
}
