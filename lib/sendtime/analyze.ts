/**
 * Per-lead send-time optimisation — plan 3.11 (analysis half).
 *
 * Each lead's optimal send window is learned from its engagement history in
 * lp.lead_events (opens, clicks, replies): the hour of day and day of week
 * the lead engages most, bucketed in the lead's timezone. That timezone
 * defaults to America/New_York (ET) until a lead-specific one is known, so
 * "lead-local" below means "in the stored timezone, ET by default".
 * Windows are stored in lp.lead_send_windows; lib/sendtime/schedule.ts
 * turns a window into an actual send time, which is the seam the journey
 * scheduler (plan 3.1) calls when dispatching timed steps.
 */
import type { Db, Queryable } from '../db/types.ts'

export class SendTimeError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SendTimeError'
    this.status = status
  }
}

/** Event types that count as engagement for send-time learning. */
export const ENGAGEMENT_TYPES = ['email_opened', 'email_link_clicked', 'reply_received']

/** Minimum engagement events before a window is trusted. */
export const MIN_SAMPLE = 5

/** Fallback timezone (ET) until a lead-specific one is known. */
export const DEFAULT_TIMEZONE = 'America/New_York'

export interface SendWindow {
  lead_key: string
  best_hour: number
  best_dow: number | null
  timezone: string
  sample_size: number
  updated_at: Date
}

/** The most specific key for a lead: a contact when there is one, else the company. */
export function leadKey(companyId?: number | null, contactId?: number | null): string {
  if (contactId != null) {
    if (!Number.isInteger(contactId) || contactId <= 0) throw new SendTimeError('contact_id must be a positive integer.')
    return `contact:${contactId}`
  }
  if (companyId == null || !Number.isInteger(companyId) || companyId <= 0) {
    throw new SendTimeError('Give a company_id or contact_id.')
  }
  return `company:${companyId}`
}

function row(r: Record<string, unknown>): SendWindow {
  return {
    lead_key: String(r.lead_key),
    best_hour: Number(r.best_hour),
    best_dow: r.best_dow == null ? null : Number(r.best_dow),
    timezone: String(r.timezone),
    sample_size: Number(r.sample_size),
    updated_at: new Date(String(r.updated_at)),
  }
}

export async function getSendWindow(q: Queryable, key: string): Promise<SendWindow | null> {
  const r = await q.query<Record<string, unknown>>('select * from lp.lead_send_windows where lead_key = $1', [key])
  return r.rows.length ? row(r.rows[0]) : null
}

interface Bucket {
  h: number
  dow: number
  n: number
}

/**
 * Learn a lead's window from its engagement events. Returns null when there
 * is not enough evidence (fewer than MIN_SAMPLE engagements). Pure
 * bucketing is in pickWindow so tests do not need a database.
 */
export function pickWindow(buckets: Bucket[], timezone: string, leadKey: string): Omit<SendWindow, 'updated_at'> | null {
  const total = buckets.reduce((s, b) => s + b.n, 0)
  if (total < MIN_SAMPLE) return null
  const byHour = new Map<number, number>()
  const byDow = new Map<number, number>()
  for (const b of buckets) {
    byHour.set(b.h, (byHour.get(b.h) ?? 0) + b.n)
    byDow.set(b.dow, (byDow.get(b.dow) ?? 0) + b.n)
  }
  const argmax = (m: Map<number, number>): number =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  const bestHour = argmax(byHour)
  const bestDowCount = Math.max(...byDow.values())
  // Only claim a best day when it clearly beats the average day.
  const bestDow = bestDowCount >= (total / 7) * 1.5 ? argmax(byDow) : null
  return { lead_key: leadKey, best_hour: bestHour, best_dow: bestDow, timezone, sample_size: total }
}

export async function computeSendWindow(
  q: Queryable,
  key: string,
  opts: { timezone?: string } = {},
): Promise<Omit<SendWindow, 'updated_at'> | null> {
  const m = /^(company|contact):([0-9]+)$/.exec(key)
  if (!m) throw new SendTimeError(`Bad lead key "${key}".`)
  const [, kind, id] = m
  const idNum = Number(id)
  // Keep the lead's own timezone when we already learned one for it.
  const existing = await getSendWindow(q, key)
  const tz = opts.timezone ?? existing?.timezone ?? DEFAULT_TIMEZONE
  const r = await q.query<Bucket>(
    `select extract(hour from occurred_at at time zone $1)::int as h,
            extract(dow from occurred_at at time zone $1)::int as dow,
            count(*)::int as n
     from lp.lead_events
     where type = any($2)
       and ${kind === 'contact' ? 'contact_id = $3' : 'company_id = $3'}
     group by 1, 2`,
    [tz, ENGAGEMENT_TYPES, idNum],
  )
  return pickWindow(r.rows, tz, key)
}

/**
 * Recompute one lead's window and store it. When there is not enough
 * evidence the existing row is left alone (a stale window beats none).
 */
export async function recomputeSendWindow(
  db: Db,
  key: string,
  opts: { timezone?: string } = {},
): Promise<SendWindow | null> {
  const computed = await computeSendWindow(db, key, opts)
  if (!computed) return getSendWindow(db, key)
  const r = await db.query<Record<string, unknown>>(
    `insert into lp.lead_send_windows (lead_key, best_hour, best_dow, timezone, sample_size, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (lead_key) do update
       set best_hour = excluded.best_hour,
           best_dow = excluded.best_dow,
           timezone = excluded.timezone,
           sample_size = excluded.sample_size,
           updated_at = now()
     returning *`,
    [computed.lead_key, computed.best_hour, computed.best_dow, computed.timezone, computed.sample_size],
  )
  return row(r.rows[0])
}

/**
 * Recompute windows for leads with recent engagement (the runner's nightly
 * job calls this). Optionally scoped to one campaign's leads.
 */
export async function recomputeSendWindows(
  db: Db,
  opts: { campaign_id?: number | null; limit?: number } = {},
): Promise<{ recomputed: number; skipped: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 500), 1), 5000)
  const params: unknown[] = [ENGAGEMENT_TYPES]
  let campaignJoin = ''
  if (opts.campaign_id != null) {
    campaignJoin = 'join lp.campaign_leads cl on cl.company_id = e.company_id and cl.campaign_id = $2'
    params.push(opts.campaign_id)
  }
  // Most-recently-engaged leads first (deterministic order), in pages: an
  // unordered DISTINCT ... LIMIT could starve leads forever.
  const PAGE = 500
  let recomputed = 0
  let skipped = 0
  let done = 0
  for (;;) {
    const r = await db.query<{ lead_key: string }>(
      `select
         case when e.contact_id is not null then 'contact:' || e.contact_id else 'company:' || e.company_id end as lead_key,
         max(e.occurred_at) as last_engagement
       from lp.lead_events e
       ${campaignJoin}
       where e.type = any($1)
         and e.occurred_at > now() - interval '90 days'
         and e.company_id is not null
       group by 1
       order by last_engagement desc
       limit ${PAGE} offset ${done}`,
      params,
    )
    if (!r.rows.length) break
    for (const { lead_key } of r.rows) {
      const w = await recomputeSendWindow(db, lead_key)
      if (w) recomputed++
      else skipped++
    }
    done += r.rows.length
    if (done >= limit || r.rows.length < PAGE) break
  }
  return { recomputed, skipped }
}
