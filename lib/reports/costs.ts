/**
 * Cost per reply / interested / meeting, by campaign and by angle.
 *
 * - Costs come only from lp.monthly_costs (typed in by a human). A monthly
 *   amount is prorated by day to the selected date range.
 * - A cost row with a campaign is that campaign's. A shared row (no campaign)
 *   is split across campaigns by their share of emails sent in the range; when
 *   nothing was sent it stays "unallocated" and is shown as such.
 * - Counts come only from Instantly (CampaignRow.counts). A null count is
 *   "no data" and every rate or cost built on it is null too. Zero meetings
 *   gives no cost-per-meeting (there is nothing to divide by), never infinity.
 */
import type { Queryable } from '@/lib/db/types'
import type { CampaignRow, Counts } from '@/lib/dashboard/types'
import type { CampaignMeta } from '@/lib/reports/meta'

export type CostCategory = 'inboxes' | 'tools' | 'verification' | 'data' | 'other'
export const COST_CATEGORIES: CostCategory[] = ['inboxes', 'tools', 'verification', 'data', 'other']
export const CATEGORY_LABEL: Record<CostCategory, string> = {
  inboxes: 'Inboxes',
  tools: 'Tools',
  verification: 'Verification',
  data: 'Lead data',
  other: 'Other',
}

export interface CostRow {
  id: number
  month: string // YYYY-MM-01
  category: CostCategory
  label: string
  amount_usd: number
  campaign_id: string | null
  notes: string | null
}

export interface Span {
  start: string // YYYY-MM-DD inclusive
  end: string // YYYY-MM-DD inclusive
}

const DAY = 86_400_000
const toUtc = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)))

export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Days of `span` that fall inside the month starting at `month` (YYYY-MM-01). */
export function overlapDays(month: string, span: Span): number {
  const mStart = toUtc(month.slice(0, 7) + '-01')
  const mEnd = mStart + (daysInMonth(month) - 1) * DAY
  const s = Math.max(mStart, toUtc(span.start))
  const e = Math.min(mEnd, toUtc(span.end))
  return e < s ? 0 : Math.round((e - s) / DAY) + 1
}

/** The part of a monthly amount that falls in the span (by day). */
export function prorate(row: Pick<CostRow, 'month' | 'amount_usd'>, span: Span): number {
  const d = overlapDays(row.month, span)
  return d === 0 ? 0 : (Number(row.amount_usd) * d) / daysInMonth(row.month)
}

export interface Funnel {
  sent: number | null
  contacted: number | null
  replied: number | null
  interested: number | null
  meetings: number | null
  bounced: number | null
}

export interface CostLine extends Funnel {
  key: string
  label: string
  campaignIds: string[]
  /** Cost attributed in the range; null when no cost rows touch it. */
  cost: number | null
  /** true when part of the cost is a share of shared rows. */
  includesShared: boolean
  /** true when some campaign in this group did not report a count we summed. */
  partial: boolean
  replyRate: number | null
  interestedRate: number | null
  costPerReply: number | null
  costPerInterested: number | null
  costPerMeeting: number | null
}

export interface CostReport {
  span: Span
  campaigns: CostLine[]
  angles: CostLine[]
  totalCost: number | null
  sharedCost: number
  unallocatedShared: number
  directCostUnknownCampaign: number
  rows: number
}

export function funnelFrom(c: Counts): Funnel {
  return { sent: c.sent, contacted: c.contacted, replied: c.replied, interested: c.positive, meetings: c.meetingsBooked, bounced: c.bounced }
}

const div = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : a / b)

function line(key: string, label: string, campaignIds: string[], f: Funnel, cost: number | null, includesShared: boolean, partial: boolean): CostLine {
  return {
    key,
    label,
    campaignIds,
    ...f,
    cost,
    includesShared,
    partial,
    replyRate: div(f.replied, f.contacted),
    interestedRate: div(f.interested, f.contacted),
    costPerReply: div(cost, f.replied),
    costPerInterested: div(cost, f.interested),
    costPerMeeting: div(cost, f.meetings),
  }
}

/** Null-aware sum: all null -> null; some null -> sum of the known ones, flagged partial. */
function sumField(fs: Funnel[], k: keyof Funnel): { v: number | null; partial: boolean } {
  const known = fs.map((f) => f[k]).filter((x): x is number => x !== null)
  if (known.length === 0) return { v: null, partial: false }
  return { v: known.reduce((a, b) => a + b, 0), partial: known.length < fs.length }
}

export function buildCostReport(campaigns: CampaignRow[], costs: CostRow[], meta: Map<string, CampaignMeta>, span: Span): CostReport {
  const ids = new Set(campaigns.map((c) => c.id))
  const direct = new Map<string, number>()
  let shared = 0
  let unknownDirect = 0
  let touched = 0
  for (const r of costs) {
    const amt = prorate(r, span)
    if (amt === 0) continue
    touched++
    if (r.campaign_id) {
      if (ids.has(r.campaign_id)) direct.set(r.campaign_id, (direct.get(r.campaign_id) ?? 0) + amt)
      else unknownDirect += amt
    } else shared += amt
  }
  const sentTotal = campaigns.reduce((s, c) => s + (c.counts.sent ?? 0), 0)
  const unallocated = sentTotal > 0 ? 0 : shared

  const campaignLines = campaigns.map((c) => {
    const d = direct.get(c.id)
    const share = sentTotal > 0 && c.counts.sent !== null ? (shared * c.counts.sent) / sentTotal : 0
    const hasCost = d !== undefined || share > 0
    const cost = hasCost ? (d ?? 0) + share : touched > 0 ? 0 : null
    return line(c.id, c.name, [c.id], funnelFrom(c.counts), cost, share > 0, false)
  })

  const groups = new Map<string, CostLine[]>()
  for (const l of campaignLines) {
    const angle = meta.get(l.key)?.angle ?? null
    const k = angle ? angle.toLowerCase() : '\u0000unset'
    groups.set(k, [...(groups.get(k) ?? []), l])
  }
  const angleLines = [...groups.entries()].map(([k, ls]) => {
    const label = k === '\u0000unset' ? 'Angle not set' : (meta.get(ls[0].key)?.angle as string)
    const f: Funnel = { sent: null, contacted: null, replied: null, interested: null, meetings: null, bounced: null }
    let partial = false
    for (const field of Object.keys(f) as (keyof Funnel)[]) {
      const s = sumField(ls, field)
      f[field] = s.v
      partial ||= s.partial
    }
    const costs = ls.map((l) => l.cost).filter((x): x is number => x !== null)
    const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null
    return line(k === '\u0000unset' ? 'unset' : k, label, ls.map((l) => l.key), f, cost, ls.some((l) => l.includesShared), partial)
  })
  angleLines.sort((a, b) => (a.key === 'unset' ? 1 : b.key === 'unset' ? -1 : a.label.localeCompare(b.label)))

  const total = touched > 0 ? [...direct.values()].reduce((a, b) => a + b, 0) + shared + unknownDirect : null
  return {
    span,
    campaigns: campaignLines,
    angles: angleLines,
    totalCost: total,
    sharedCost: shared,
    unallocatedShared: unallocated,
    directCostUnknownCampaign: unknownDirect,
    rows: touched,
  }
}

/** The best and worst angle by reply rate, among angles with enough contacted leads to say. */
export const MIN_CONTACTED_TO_RANK = 50
export function bestWorst(lines: CostLine[], min = MIN_CONTACTED_TO_RANK): { best: CostLine | null; worst: CostLine | null; ranked: number } {
  const rankable = lines.filter((l) => l.key !== 'unset' && l.contacted !== null && l.contacted >= min && l.replyRate !== null)
  if (rankable.length === 0) return { best: null, worst: null, ranked: 0 }
  const sorted = [...rankable].sort((a, b) => (b.replyRate as number) - (a.replyRate as number))
  return { best: sorted[0], worst: sorted.length > 1 ? sorted[sorted.length - 1] : null, ranked: sorted.length }
}

// ------------------------------------------------------------------ storage

export async function listCosts(q: Queryable, span?: Span): Promise<CostRow[]> {
  const { rows } = await q.query<CostRow & { month: string | Date }>(
    span
      ? `select id, to_char(month, 'YYYY-MM-DD') as month, category, label, amount_usd, campaign_id, notes from lp.monthly_costs
          where month <= $2::date and (month + interval '1 month') > $1::date order by month desc, category, label`
      : `select id, to_char(month, 'YYYY-MM-DD') as month, category, label, amount_usd, campaign_id, notes from lp.monthly_costs order by month desc, category, label`,
    span ? [span.start, span.end] : [],
  )
  return rows.map((r) => ({ ...r, month: String(r.month), amount_usd: Number(r.amount_usd) }))
}

export function parseMonth(v: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v.trim())
  if (!m) return null
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return `${m[1]}-${m[2]}-01`
}

export async function upsertCost(
  q: Queryable,
  actor: string,
  input: { month: string; category: string; label: string; amount_usd: number; campaign_id?: string | null; notes?: string | null },
): Promise<CostRow> {
  const month = parseMonth(input.month)
  if (!month) throw new Error('Month must look like 2026-10.')
  if (!(COST_CATEGORIES as string[]).includes(input.category)) throw new Error('Pick a cost category.')
  const label = String(input.label ?? '').trim().slice(0, 120)
  if (!label) throw new Error('Give the cost a name (e.g. "27 Google Workspace inboxes").')
  const amount = Number(input.amount_usd)
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Amount must be a dollar figure, 0 or more.')
  const { rows } = await q.query<CostRow>(
    `insert into lp.monthly_costs (month, category, label, amount_usd, campaign_id, notes, created_by)
     values ($1::date, $2, $3, $4, $5, $6, $7)
     on conflict (month, category, label, coalesce(campaign_id, '')) do update
       set amount_usd = excluded.amount_usd, notes = excluded.notes
     returning id, to_char(month, 'YYYY-MM-DD') as month, category, label, amount_usd, campaign_id, notes`,
    [month, input.category, label, Math.round(amount * 100) / 100, input.campaign_id || null, input.notes?.trim() || null, actor],
  )
  return { ...rows[0], amount_usd: Number(rows[0].amount_usd) }
}

export async function deleteCost(q: Queryable, id: number): Promise<boolean> {
  const r = await q.query('delete from lp.monthly_costs where id = $1', [id])
  return (r.rowCount ?? 0) > 0
}

/** Paid verification spend recorded by verification runs in a span (measured, not typed). */
export async function verificationSpend(q: Queryable, span: Span): Promise<number> {
  const { rows } = await q.query<{ spent: number | null }>(
    `select sum(spent_usd) as spent from lp.verification_runs
      where coalesce(finished_at, approved_at, created_at) >= $1::date
        and coalesce(finished_at, approved_at, created_at) < ($2::date + 1)`,
    [span.start, span.end],
  )
  return Number(rows[0]?.spent ?? 0)
}
