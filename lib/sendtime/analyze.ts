/**
 * Per-lead send-time optimisation — plan 3.11 (analysis half).
 *
 * Each lead's optimal send window is learned from its engagement history in
 * lp.lead_events: the hour of day and weekday it engages most. Only replies
 * and clicks count (replies weigh more); opens are excluded entirely, see
 * config.ts and docs/SEND_TIME.md. Events are bucketed by occurred_at, when
 * the person actually engaged, in the lead's timezone. No lead carries a
 * timezone today, so that is America/New_York and every window says so
 * (timezone_source = 'default'); a real timezone, once known, is stored with
 * source 'lead'.
 *
 * Evidence falls back in two steps: a contact with too little of its own
 * evidence uses its company's events (basis = 'company'), and a lead with no
 * window at all can use the campaign's aggregate window (a separate table,
 * lp.campaign_send_windows). Windows are stored in lp.lead_send_windows;
 * lib/sendtime/schedule.ts turns a window into an actual send time.
 */
import type { Db, Queryable } from '../db/types.ts'
import {
  BUSINESS_DAYS,
  BUSINESS_HOURS_MIDPOINT,
  DEFAULT_TIMEZONE,
  DISCOVERY_DAYS,
  ENGAGEMENT_TYPES,
  ENGAGEMENT_WEIGHTS,
  MIN_SAMPLE,
  WINDOW_MAX_AGE_DAYS,
} from './config.ts'
import { leadKey, parseLeadKey, SendTimeError } from './lead-key.ts'
import { isValidTimezone, resolveTimezone, type TimezoneSource } from './tz.ts'

// One import surface for callers and tests.
export { DEFAULT_TIMEZONE, ENGAGEMENT_TYPES, MIN_SAMPLE, WINDOW_MAX_AGE_DAYS, leadKey, parseLeadKey, SendTimeError }

/** Where a lead window's evidence came from: the lead's own events, or (contacts only) its company's. */
export type WindowBasis = 'own' | 'company'

/** What every stored window carries. */
export interface WindowBase {
  best_hour: number
  /** 1-5 (Mon-Fri), or null when no weekday clearly wins. Never a weekend day. */
  best_dow: number | null
  timezone: string
  /** 'default' = America/New_York was assumed, not learned from the lead. */
  timezone_source: TimezoneSource
  /** Engagement events (replies + clicks) the window was learned from. */
  sample_size: number
  /** occurred_at of the newest event used; drives expiry. */
  last_engagement: Date
  updated_at: Date
}

export interface SendWindow extends WindowBase {
  lead_key: string
  basis: WindowBasis
}

export interface CampaignSendWindow extends WindowBase {
  campaign_id: number
}

export type ComputedWindow = Omit<SendWindow, 'updated_at'>
export type ComputedCampaignWindow = Omit<CampaignSendWindow, 'updated_at'>

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v))
}

function baseFromRow(r: Record<string, unknown>): WindowBase {
  return {
    best_hour: Number(r.best_hour),
    best_dow: r.best_dow == null ? null : Number(r.best_dow),
    timezone: String(r.timezone),
    timezone_source: r.timezone_source === 'lead' ? 'lead' : 'default',
    sample_size: Number(r.sample_size),
    last_engagement: toDate(r.last_engagement),
    updated_at: toDate(r.updated_at),
  }
}

function row(r: Record<string, unknown>): SendWindow {
  return { lead_key: String(r.lead_key), basis: r.basis === 'company' ? 'company' : 'own', ...baseFromRow(r) }
}

function campaignRow(r: Record<string, unknown>): CampaignSendWindow {
  return { campaign_id: Number(r.campaign_id), ...baseFromRow(r) }
}

/** The stored window row for a lead, expired or not (see isWindowExpired). */
export async function getSendWindow(q: Queryable, key: string): Promise<SendWindow | null> {
  const r = await q.query<Record<string, unknown>>('select * from lp.lead_send_windows where lead_key = $1', [key])
  return r.rows.length ? row(r.rows[0]) : null
}

export async function getCampaignSendWindow(q: Queryable, campaignId: number): Promise<CampaignSendWindow | null> {
  const r = await q.query<Record<string, unknown>>('select * from lp.campaign_send_windows where campaign_id = $1', [campaignId])
  return r.rows.length ? campaignRow(r.rows[0]) : null
}

/**
 * True when a window's newest evidence is older than WINDOW_MAX_AGE_DAYS.
 * An expired window is treated as absent by resolveSendTime and the preview:
 * a lead who went quiet half a year ago should not keep a send hour forever.
 */
export function isWindowExpired(w: Pick<WindowBase, 'last_engagement'>, now: Date = new Date()): boolean {
  return now.getTime() - w.last_engagement.getTime() > WINDOW_MAX_AGE_DAYS * 86400000
}

export interface Bucket {
  /** Hour of day, 0-23, in the window's timezone. */
  h: number
  /** Day of week, 0 = Sunday. */
  dow: number
  /** Engagement events in the bucket. */
  n: number
  /** Weighted engagement (reply 3, click 2). Defaults to n when absent. */
  w?: number
}

export interface Picked {
  best_hour: number
  best_dow: number | null
  sample_size: number
}

/**
 * Learn a window from bucketed engagement. Returns null when there is not
 * enough evidence (fewer than MIN_SAMPLE events). Pure, so tests need no
 * database.
 *
 * Hour: the 24 hourly weights are smoothed with a circular [1,2,1] kernel
 * (each hour also hears its neighbours at half weight, so a lead who engages
 * at 10 and 11 peaks between them, and one stray 3am click cannot beat a
 * cluster). The best smoothed hour wins; ties go to the hour closest to the
 * middle of business hours (13:00), then to the earlier hour. Never "lowest
 * hour wins", which on thin data meant midnight.
 *
 * Day: Monday to Friday only (business outreach), and only when the best
 * weekday clearly beats the average day (1.5x the mean over all seven).
 * Weekend engagement still counts toward the hour, never toward the day.
 */
export function pickWindow(buckets: Bucket[]): Picked | null {
  const total = buckets.reduce((s, b) => s + b.n, 0)
  if (total < MIN_SAMPLE) return null

  const hourW = new Array<number>(24).fill(0)
  const dowW = new Array<number>(7).fill(0)
  for (const b of buckets) {
    const w = b.w ?? b.n
    hourW[b.h] += w
    dowW[b.dow] += w
  }
  const smooth = hourW.map((w, h) => 2 * w + hourW[(h + 23) % 24] + hourW[(h + 1) % 24])
  let bestHour = 0
  for (let h = 1; h < 24; h++) {
    const better = smooth[h] > smooth[bestHour]
    const tie = smooth[h] === smooth[bestHour]
    const closer = Math.abs(h - BUSINESS_HOURS_MIDPOINT) < Math.abs(bestHour - BUSINESS_HOURS_MIDPOINT)
    if (better || (tie && closer)) bestHour = h
  }

  const allW = dowW.reduce((s, w) => s + w, 0)
  let top: number = BUSINESS_DAYS[0]
  for (const d of BUSINESS_DAYS) if (dowW[d] > dowW[top]) top = d
  // Judged against the average of ALL seven days, so a lead whose engagement is
  // mostly weekend does not get a "best weekday" out of a couple of stray events.
  const bestDow = dowW[top] > 0 && dowW[top] >= (allW / 7) * 1.5 ? top : null
  return { best_hour: bestHour, best_dow: bestDow, sample_size: total }
}

export interface ComputeOpts {
  /** A timezone known for this lead. Invalid values fall back to the default and are labelled so. */
  timezone?: string
  /** Evaluation time; defaults to the current time. Evidence older than WINDOW_MAX_AGE_DAYS before it is ignored. */
  now?: Date
}

interface Evidence {
  buckets: Bucket[]
  last_engagement: Date | null
}

/**
 * Shared evidence filter: engagement types only, low-trust events dropped,
 * inside the evidence horizon. $1 tz, $2 types, $3 now, $4 weights.
 */
const EVIDENCE_WHERE = `e.type = any($2)
       and (e.props->>'low_trust') is distinct from 'true'
       and e.occurred_at <= $3::timestamptz
       and e.occurred_at > $3::timestamptz - interval '${WINDOW_MAX_AGE_DAYS} days'`

async function loadEvidence(q: Queryable, tz: string, now: Date, scope: string, scopeParams: unknown[]): Promise<Evidence> {
  // tz is validated by resolveTimezone before it gets here; it is still a bound parameter.
  const r = await q.query<{ h: number; dow: number; n: number; w: number; last_at: Date | string }>(
    `select extract(hour from e.occurred_at at time zone $1)::int as h,
            extract(dow from e.occurred_at at time zone $1)::int as dow,
            count(*)::int as n,
            sum(($4::jsonb ->> e.type)::int)::int as w,
            max(e.occurred_at) as last_at
     from lp.lead_events e
     where ${EVIDENCE_WHERE}
       and ${scope}
     group by 1, 2`,
    [tz, ENGAGEMENT_TYPES, now.toISOString(), JSON.stringify(ENGAGEMENT_WEIGHTS), ...scopeParams],
  )
  let last: Date | null = null
  for (const b of r.rows) {
    const d = toDate(b.last_at)
    if (!last || d > last) last = d
  }
  return { buckets: r.rows.map((b) => ({ h: Number(b.h), dow: Number(b.dow), n: Number(b.n), w: Number(b.w) })), last_engagement: last }
}

/**
 * Learn a lead's window from its engagement events; null when there is not
 * enough evidence. A contact with fewer than MIN_SAMPLE events of its own
 * borrows its company's (basis 'company'): a company-level reply or click is
 * still evidence about when that business reads mail.
 */
export async function computeSendWindow(q: Queryable, key: string, opts: ComputeOpts = {}): Promise<ComputedWindow | null> {
  const { kind, id } = parseLeadKey(key)
  const now = opts.now ?? new Date()
  // Keep the lead's own timezone when we already learned one for it.
  const existing = await getSendWindow(q, key)
  const tzInfo =
    opts.timezone != null
      ? resolveTimezone(opts.timezone)
      : existing && existing.timezone_source === 'lead' && isValidTimezone(existing.timezone)
        ? { timezone: existing.timezone, timezone_source: 'lead' as const }
        : resolveTimezone(null)

  let basis: WindowBasis = 'own'
  let ev = await loadEvidence(q, tzInfo.timezone, now, kind === 'contact' ? 'e.contact_id = $5' : 'e.company_id = $5', [id])
  let picked = pickWindow(ev.buckets)
  if (!picked && kind === 'contact') {
    const c = await q.query<{ company_id: number | null }>('select company_id from lp.contacts where id = $1', [id])
    const companyId = c.rows[0]?.company_id
    if (companyId != null) {
      ev = await loadEvidence(q, tzInfo.timezone, now, '(e.contact_id = $5 or e.company_id = $6)', [id, companyId])
      picked = pickWindow(ev.buckets)
      basis = 'company'
    }
  }
  if (!picked || !ev.last_engagement) return null
  return { lead_key: key, basis, ...picked, ...tzInfo, last_engagement: ev.last_engagement }
}

/** Write a computed window (insert or update). */
export async function storeSendWindow(q: Queryable, w: ComputedWindow): Promise<SendWindow> {
  const r = await q.query<Record<string, unknown>>(
    `insert into lp.lead_send_windows (lead_key, best_hour, best_dow, timezone, timezone_source, sample_size, last_engagement, basis, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (lead_key) do update
       set best_hour = excluded.best_hour,
           best_dow = excluded.best_dow,
           timezone = excluded.timezone,
           timezone_source = excluded.timezone_source,
           sample_size = excluded.sample_size,
           last_engagement = excluded.last_engagement,
           basis = excluded.basis,
           updated_at = now()
     returning *`,
    [w.lead_key, w.best_hour, w.best_dow, w.timezone, w.timezone_source, w.sample_size, w.last_engagement, w.basis],
  )
  return row(r.rows[0])
}

/**
 * Recompute one lead's window and store it. When there is not enough
 * evidence the existing row is returned untouched (nothing is written); it
 * ages out on its own once its newest evidence passes WINDOW_MAX_AGE_DAYS.
 */
export async function recomputeSendWindow(db: Db, key: string, opts: ComputeOpts = {}): Promise<SendWindow | null> {
  const computed = await computeSendWindow(db, key, opts)
  if (!computed) return getSendWindow(db, key)
  return storeSendWindow(db, computed)
}

/**
 * The campaign-level fallback: the same learning, over the engagement of all
 * of a campaign's leads (campaign_leads rows, plus events tagged with the
 * campaign), bucketed in the default timezone. Used by resolveSendTime for a
 * lead that has no usable window of its own.
 */
export async function computeCampaignWindow(q: Queryable, campaignId: number, opts: { now?: Date } = {}): Promise<ComputedCampaignWindow | null> {
  const now = opts.now ?? new Date()
  const tzInfo = resolveTimezone(null)
  const ev = await loadEvidence(
    q,
    tzInfo.timezone,
    now,
    `(e.campaign_id = $5 or exists (
         select 1 from lp.campaign_leads cl
         where cl.campaign_id = $5 and (cl.company_id = e.company_id or cl.contact_id = e.contact_id)))`,
    [campaignId],
  )
  const picked = pickWindow(ev.buckets)
  if (!picked || !ev.last_engagement) return null
  return { campaign_id: campaignId, ...picked, ...tzInfo, last_engagement: ev.last_engagement }
}

export async function storeCampaignWindow(q: Queryable, w: ComputedCampaignWindow): Promise<CampaignSendWindow> {
  const r = await q.query<Record<string, unknown>>(
    `insert into lp.campaign_send_windows (campaign_id, best_hour, best_dow, timezone, timezone_source, sample_size, last_engagement, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (campaign_id) do update
       set best_hour = excluded.best_hour,
           best_dow = excluded.best_dow,
           timezone = excluded.timezone,
           timezone_source = excluded.timezone_source,
           sample_size = excluded.sample_size,
           last_engagement = excluded.last_engagement,
           updated_at = now()
     returning *`,
    [w.campaign_id, w.best_hour, w.best_dow, w.timezone, w.timezone_source, w.sample_size, w.last_engagement],
  )
  return campaignRow(r.rows[0])
}

export async function recomputeCampaignWindow(db: Db, campaignId: number, opts: { now?: Date } = {}): Promise<CampaignSendWindow | null> {
  const computed = await computeCampaignWindow(db, campaignId, opts)
  if (!computed) return getCampaignSendWindow(db, campaignId)
  return storeCampaignWindow(db, computed)
}

export interface RecomputeReport {
  /** Leads whose window was computed and written. */
  recomputed: number
  /** Leads with engagement but too little evidence: nothing was written. */
  skipped: number
  campaigns_recomputed: number
  campaigns_skipped: number
}

const PAGE = 500

/**
 * Recompute windows for leads with recent engagement (the runner's nightly
 * sendtime_recompute job calls this), then the campaign-level windows.
 * Optionally scoped to one campaign.
 *
 * Every lead that engaged in the last DISCOVERY_DAYS is covered, contact-only
 * leads included (an event with a contact but no company is keyed contact:<id>).
 * Leads are paged by keyset on (last_engagement desc, lead_key asc): the
 * tiebreaker makes the order total, and the cursor (not OFFSET) means a page
 * never skips or repeats a lead. `limit` is exact: the last page asks for
 * only what is left.
 *
 * The report matches what was stored: a lead counts as recomputed only when a
 * row was written, as skipped when its evidence was below MIN_SAMPLE.
 */
export async function recomputeSendWindows(
  db: Db,
  opts: { campaign_id?: number | null; limit?: number; now?: Date; /** rows per page; for tests */ pageSize?: number } = {},
): Promise<RecomputeReport> {
  const page = Math.min(Math.max(Math.floor(Number(opts.pageSize) || PAGE), 1), PAGE)
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 500), 1), 5000)
  const now = opts.now ?? new Date()
  const base: unknown[] = [ENGAGEMENT_TYPES, now.toISOString(), DISCOVERY_DAYS]
  let scope = ''
  if (opts.campaign_id != null) {
    base.push(opts.campaign_id)
    scope = `and (e.campaign_id = $4 or exists (
        select 1 from lp.campaign_leads cl
        where cl.campaign_id = $4 and (cl.company_id = e.company_id or cl.contact_id = e.contact_id)))`
  }
  const nCursor = base.length + 1 // $n: cursor timestamp, $n+1: cursor key

  const report: RecomputeReport = { recomputed: 0, skipped: 0, campaigns_recomputed: 0, campaigns_skipped: 0 }
  let done = 0
  let cursor: { at: string; key: string } | null = null
  for (;;) {
    const pageSize = Math.min(page, limit - done)
    if (pageSize <= 0) break
    const r: { rows: { lead_key: string; last_engagement: string }[] } = await db.query<{ lead_key: string; last_engagement: string }>(
      `select lead_key, last_engagement::text as last_engagement
       from (
         select case when e.contact_id is not null then 'contact:' || e.contact_id else 'company:' || e.company_id end as lead_key,
                max(e.occurred_at) as last_engagement
         from lp.lead_events e
         where e.type = any($1)
           and (e.props->>'low_trust') is distinct from 'true'
           and e.occurred_at <= $2::timestamptz
           and e.occurred_at > $2::timestamptz - make_interval(days => $3::int)
           and (e.contact_id is not null or e.company_id is not null)
           ${scope}
         group by 1
       ) t
       where $${nCursor}::timestamptz is null
          or last_engagement < $${nCursor}::timestamptz
          or (last_engagement = $${nCursor}::timestamptz and lead_key > $${nCursor + 1}::text)
       order by last_engagement desc, lead_key asc
       limit ${pageSize}`,
      [...base, cursor?.at ?? null, cursor?.key ?? null],
    )
    for (const { lead_key } of r.rows) {
      const computed = await computeSendWindow(db, lead_key, { now })
      if (!computed) {
        report.skipped++
        continue
      }
      await storeSendWindow(db, computed)
      report.recomputed++
    }
    done += r.rows.length
    if (r.rows.length < pageSize) break
    const lastRow: { lead_key: string; last_engagement: string } = r.rows[r.rows.length - 1]
    cursor = { at: lastRow.last_engagement, key: lastRow.lead_key }
  }

  const campaigns =
    opts.campaign_id != null
      ? [opts.campaign_id]
      : (await db.query<{ id: number }>('select id from lp.campaigns order by id limit 1000')).rows.map((c) => Number(c.id))
  for (const id of campaigns) {
    const computed = await computeCampaignWindow(db, id, { now })
    if (!computed) {
      report.campaigns_skipped++
      continue
    }
    await storeCampaignWindow(db, computed)
    report.campaigns_recomputed++
  }
  return report
}
