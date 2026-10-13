/**
 * The reply desk, read from lp.campaign_touches (written by the Instantly
 * webhook receiver). One entry per lead email: its newest desk event decides
 * the bucket. Nothing is sent from here.
 *
 * Event names are Instantly's webhook event_type values (developer.instantly.ai):
 * reply_received, auto_reply_received, email_bounced, lead_unsubscribed,
 * lead_interested, lead_not_interested, lead_neutral, lead_meeting_booked,
 * lead_meeting_completed, lead_closed, lead_out_of_office, lead_wrong_person.
 * email_sent / email_opened / link clicks are not desk events.
 */
import type { Queryable } from '@/lib/db/types'

export const REPLY_BUCKETS = ['needs_reply', 'interested', 'not_now', 'auto', 'unsubscribed', 'bounced', 'answered'] as const
export type ReplyBucket = (typeof REPLY_BUCKETS)[number]

export const BUCKET_LABELS: Record<ReplyBucket, string> = {
  needs_reply: 'Needs a reply',
  interested: 'Interested',
  not_now: 'Not now',
  auto: 'Auto-replies',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  answered: 'Answered',
}

const EVENT_BUCKET: Record<string, Exclude<ReplyBucket, 'answered'>> = {
  reply_received: 'needs_reply',
  lead_interested: 'interested',
  lead_meeting_booked: 'interested',
  lead_meeting_completed: 'interested',
  lead_closed: 'interested',
  lead_not_interested: 'not_now',
  lead_neutral: 'not_now',
  lead_wrong_person: 'not_now',
  auto_reply_received: 'auto',
  lead_out_of_office: 'auto',
  lead_unsubscribed: 'unsubscribed',
  email_bounced: 'bounced',
}
export const DESK_EVENTS = Object.keys(EVENT_BUCKET)

export function bucketFor(eventType: string, answeredAfter: boolean): ReplyBucket | null {
  const b = EVENT_BUCKET[eventType]
  if (!b) return null
  if (b === 'needs_reply' && answeredAfter) return 'answered'
  return b
}

export interface ReplyItem {
  touch_id: number
  email: string | null
  company_id: number | null
  company_name: string | null
  city: string | null
  state: string | null
  campaign_name: string | null
  event_type: string
  occurred_at: Date
  subject: string | null
  snippet: string | null
  unibox_url: string | null
  /** A human reply (reply_received) exists in this lead's thread, even if a later label changed the bucket. */
  replies: number
  bucket: ReplyBucket
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Only https links out of a webhook payload; anything else is dropped. */
function safeUrl(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** The desk's leads: one row per lead email, its newest desk event. Shared by the list and the counts. */
const DESK_CTE = `with desk as (
       select t.*, lower(coalesce(t.email, ct.email_norm, t.payload->>'lead_email')) as lead_key,
              coalesce(t.company_id, ct.company_id) as co_id
         from lp.campaign_touches t
         left join lp.contacts ct on ct.id = t.contact_id
        where t.event_type = any($1::text[])
     ), latest as (
       select distinct on (lead_key) * from desk where lead_key is not null
        order by lead_key, occurred_at desc, id desc
     )`

const ANSWERED_AFTER_SQL = `exists (select 1 from lp.campaign_touches s
                     where s.event_type = 'email_sent' and s.occurred_at > l.occurred_at
                       and lower(coalesce(s.email, s.payload->>'lead_email')) = l.lead_key)`

/**
 * How many leads sit in each bucket, over EVERY lead with a desk event. The list below is
 * capped (500 newest) to keep the page light; counting the buckets from that capped list made
 * "Replies waiting" and "Interested" drop older leads silently once bounces, auto-replies and
 * unsubscribes filled the 500 slots. The Overview tiles and the Replies header use these.
 */
export async function replyDeskCounts(db: Queryable): Promise<Record<ReplyBucket, number> & { total: number }> {
  const { rows } = await db.query<{ event_type: string; answered_after: boolean; n: number }>(
    `${DESK_CTE}, b as (select l.event_type, ${ANSWERED_AFTER_SQL} as answered_after from latest l)
     select event_type, answered_after, count(*)::int as n from b group by event_type, answered_after`,
    [DESK_EVENTS],
  )
  const out = Object.fromEntries(REPLY_BUCKETS.map((k) => [k, 0])) as Record<ReplyBucket, number> & { total: number }
  out.total = 0
  for (const r of rows) {
    const bucket = bucketFor(r.event_type, Boolean(r.answered_after))
    if (!bucket) continue
    out[bucket] += Number(r.n)
    out.total += Number(r.n)
  }
  return out
}

export async function loadReplyDesk(db: Queryable, limitPerLead = 500): Promise<ReplyItem[]> {
  const { rows } = await db.query<{
    id: number; email: string | null; company_id: number | null; company_name: string | null; city: string | null
    state: string | null; campaign_name: string | null; event_type: string; occurred_at: Date
    payload: Record<string, unknown> | null; answered_after: boolean; replies: number; last_reply_payload: Record<string, unknown> | null
  }>(
    `${DESK_CTE}
     select l.id, l.lead_key as email, l.co_id as company_id, co.name as company_name, co.city, co.state,
            coalesce(l.campaign_name, l.payload->>'campaign_name') as campaign_name, l.event_type, l.occurred_at, l.payload,
            ${ANSWERED_AFTER_SQL} as answered_after,
            (select count(*)::int from desk d where d.lead_key = l.lead_key and d.event_type = 'reply_received') as replies,
            (select d.payload from desk d where d.lead_key = l.lead_key and d.event_type = 'reply_received'
              order by d.occurred_at desc, d.id desc limit 1) as last_reply_payload
       from latest l left join lp.companies co on co.id = l.co_id
      order by l.occurred_at desc, l.id desc
      limit $2`,
    [DESK_EVENTS, limitPerLead],
  )
  const out: ReplyItem[] = []
  for (const r of rows) {
    const bucket = bucketFor(r.event_type, r.answered_after)
    if (!bucket) continue
    // A label event (lead_interested...) carries no text; show the human reply it labels when there is one.
    const p = r.payload ?? {}
    const rp = r.last_reply_payload ?? {}
    out.push({
      touch_id: r.id,
      email: r.email,
      company_id: r.company_id,
      company_name: r.company_name,
      city: r.city,
      state: r.state,
      campaign_name: r.campaign_name,
      event_type: r.event_type,
      occurred_at: r.occurred_at,
      subject: str(p.reply_subject) ?? str(rp.reply_subject),
      snippet: str(p.reply_text_snippet) ?? str(rp.reply_text_snippet),
      unibox_url: safeUrl(p.unibox_url) ?? safeUrl(rp.unibox_url),
      replies: Number(r.replies),
      bucket,
    })
  }
  return out
}

export function groupReplies(items: ReplyItem[]): Record<ReplyBucket, ReplyItem[]> {
  const g = Object.fromEntries(REPLY_BUCKETS.map((b) => [b, [] as ReplyItem[]])) as Record<ReplyBucket, ReplyItem[]>
  for (const i of items) g[i.bucket].push(i)
  return g
}
