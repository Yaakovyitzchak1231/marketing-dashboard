/**
 * Which contacts a verification run covers: explicit ids from the Leads
 * screen, or the same filters the Leads screen uses.
 */
import type { Queryable } from '@/lib/db/types'

export interface LeadFilter {
  state?: string | null
  stage?: string | null
  verification_status?: string | null
  segment?: string | null
  /** Free text: company name, email, city, or website domain. */
  q?: string | null
}

export interface SelectOptions {
  contact_ids?: number[] | null
  filter?: LeadFilter | null
  limit?: number | null
  /** Re-check contacts verified within recheck_days (default: skip them). */
  force?: boolean
  recheck_days?: number
}

export interface CandidateRow {
  id: number
  email_norm: string | null
  status: string
  verification_status: string
  verified_at: string | Date | null
  verified_by: string | null
  do_not_contact: boolean
}

export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000
export const DEFAULT_RECHECK_DAYS = 30

export interface Selection {
  eligible: CandidateRow[]
  requested: number
  skipped: { no_email: number; do_not_contact: number; recently_verified: number }
}

export function cleanFilter(f: LeadFilter | null | undefined): LeadFilter {
  const out: LeadFilter = {}
  if (!f) return out
  for (const k of ['state', 'stage', 'verification_status', 'segment', 'q'] as const) {
    const v = f[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200)
  }
  return out
}

/**
 * A contact counts as "recently verified" (and is skipped unless forced) when
 * it was verified within recheck_days -- except catch_all / unknown answers
 * that only MillionVerifier gave (in a run, or the sheet's MV column; ZeroBounce
 * never looked), which stay eligible so the waterfall can finish them.
 */
export function isRecentlyVerified(c: CandidateRow, days: number, now = new Date()): boolean {
  if (!c.verified_at || c.verification_status === 'unverified') return false
  const at = new Date(c.verified_at).getTime()
  if (now.getTime() - at > days * 86_400_000) return false
  if (mvPending(c)) return false
  return true
}

/**
 * MillionVerifier already answered catch_all / unknown (in an earlier run, or
 * in the Lead Master sheet's MV column) and ZeroBounce has not looked yet:
 * the waterfall can skip straight to ZeroBounce without paying MV again.
 */
export function mvPending(c: Pick<CandidateRow, 'verification_status' | 'verified_by'>): 'catch_all' | 'unknown' | null {
  if (c.verified_by !== 'millionverifier' && c.verified_by !== 'sheet_import') return null
  return c.verification_status === 'catch_all' || c.verification_status === 'unknown' ? c.verification_status : null
}

export async function selectCandidates(q: Queryable, opts: SelectOptions): Promise<Selection> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)))
  const params: unknown[] = []
  const where: string[] = []
  const ids = (opts.contact_ids ?? []).filter((n) => Number.isInteger(n) && n > 0)
  if (opts.contact_ids && opts.contact_ids.length > 0) {
    params.push(ids)
    where.push(`c.id = any($${params.length}::bigint[])`)
  }
  const f = cleanFilter(opts.filter)
  if (f.state) {
    params.push(f.state.toUpperCase())
    where.push(`upper(co.state) = $${params.length}`)
  }
  if (f.stage) {
    params.push(f.stage)
    where.push(`co.stage = $${params.length}`)
  }
  if (f.verification_status) {
    params.push(f.verification_status)
    where.push(`c.verification_status = $${params.length}`)
  }
  if (f.segment) {
    params.push(f.segment)
    where.push(`co.segment = $${params.length}`)
  }
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`)
    const p = `$${params.length}`
    where.push(`(co.name ilike ${p} or c.email_norm ilike ${p} or co.city ilike ${p} or co.website_domain ilike ${p})`)
  }
  params.push(limit)
  const sql = `
    select c.id, c.email_norm, c.status, c.verification_status, c.verified_at, c.verified_by, c.do_not_contact
    from lp.contacts c
    left join lp.companies co on co.id = c.company_id
    ${where.length ? 'where ' + where.join(' and ') : ''}
    order by c.id
    limit $${params.length}`
  const { rows } = await q.query<CandidateRow>(sql, params)
  const days = opts.recheck_days ?? DEFAULT_RECHECK_DAYS
  const skipped = { no_email: 0, do_not_contact: 0, recently_verified: 0 }
  const eligible: CandidateRow[] = []
  for (const r of rows) {
    if (!r.email_norm) skipped.no_email++
    else if (r.do_not_contact || r.status === 'do-not-contact') skipped.do_not_contact++
    else if (!opts.force && isRecentlyVerified(r, days)) skipped.recently_verified++
    else eligible.push(r)
  }
  return { eligible, requested: rows.length, skipped }
}
