/**
 * Instantly webhook events -> lp.campaign_touches (+ lead status, reply desk, activity log).
 *
 * Payload shape per developer.instantly.ai/webhook-events (read Oct 8, 2026):
 * base fields timestamp, event_type, workspace, campaign_id, campaign_name; optional
 * lead_email, email_account, unibox_url, step, variant, is_first, email_id,
 * email_subject/text/html, reply_text_snippet, reply_subject, reply_text, reply_html,
 * plus any lead fields. Custom labels arrive as event_type verbatim.
 *
 * Phase 1 part 3 (lead_events, PR #63 + this PR): in the SAME transaction as the
 * campaign_touches insert, also emit a lp.lead_events row with dedupe_key
 * 'touch:<campaign_touches.id>' — the same key 0018's backfill used for every
 * pre-existing touch, so a touch is never double-counted whether it was
 * backfilled or arrived live. Only emitted when the touch insert is genuinely
 * new (a retried delivery returns early above, before this runs at all).
 *
 * Also: unsubscribe, hard bounce and complaint events add a GLOBAL suppression
 * (lp.suppressions) plus contacts.subscription_status and an lp.consent_log
 * row, with plain SQL (lib/suppressions/store.ts is a parallel PR; not imported
 * here on purpose, per the build split).
 */
import { createHash } from 'node:crypto'
import type { Db, Queryable } from '@/lib/db/types'
import { normalizeEmail } from '@/lib/leads/normalize'
import { STAGES, type Stage } from '@/lib/leads/types'
import { logEvent } from '@/lib/ops/events'
import { emitLeadEvent } from '@/lib/events/emit'

export interface InstantlyEvent {
  timestamp?: string
  event_type?: string
  workspace?: string
  campaign_id?: string
  campaign_name?: string
  lead_email?: string
  email_account?: string
  unibox_url?: string
  step?: number
  variant?: number
  is_first?: boolean
  email_id?: string
  email_subject?: string
  reply_subject?: string
  reply_text_snippet?: string
  reply_text?: string
  [k: string]: unknown
}

/** What each event does to the company's stage (forward only, except the terminal ones). */
const STAGE_FOR_EVENT: Record<string, Stage> = {
  email_sent: 'contacted',
  reply_received: 'replied',
  lead_interested: 'interested',
  lead_meeting_booked: 'meeting',
  lead_meeting_completed: 'meeting',
  lead_closed: 'won',
  lead_not_interested: 'lost',
  lead_unsubscribed: 'do_not_contact',
}
const TERMINAL: Stage[] = ['lost', 'do_not_contact', 'won']

/** Contact status (the Sheet vocabulary) for each event. */
const CONTACT_STATUS_FOR_EVENT: Record<string, string> = {
  email_sent: 'sent',
  reply_received: 'replied',
  auto_reply_received: 'sent',
  email_bounced: 'bounced',
  lead_unsubscribed: 'do-not-contact',
}

export const REPLY_EVENTS = new Set(['reply_received', 'lead_interested', 'lead_meeting_booked'])

/**
 * Instantly event_type -> lp.event_types key (0018 seeded these, so an entry
 * here must name one of them). An Instantly type with no entry here is
 * recorded as 'custom' with props.instantly_type set to the original value —
 * nothing from Instantly is ever dropped, and a new type just needs one line
 * here (or register_event_type + an entry here) once it's worth its own key.
 */
export const INSTANTLY_EVENT_TYPE_MAP: Record<string, string> = {
  email_sent: 'email_sent',
  email_opened: 'email_opened',
  email_link_clicked: 'email_link_clicked',
  link_clicked: 'email_link_clicked',
  reply_received: 'reply_received',
  auto_reply_received: 'auto_reply_received',
  email_bounced: 'email_bounced',
  lead_unsubscribed: 'lead_unsubscribed',
  lead_interested: 'lead_interested',
  lead_not_interested: 'lead_not_interested',
  lead_meeting_booked: 'meeting_booked',
  lead_meeting_completed: 'meeting_booked',
  campaign_completed: 'campaign_completed',
}

/** Events that add a GLOBAL suppression (campaign_id null = every campaign). */
const SUPPRESSION_FOR_EVENT: Record<string, { reason: string; subscription_status: string }> = {
  lead_unsubscribed: { reason: 'unsubscribed', subscription_status: 'unsubscribed' },
  email_bounced: { reason: 'bounced', subscription_status: 'bounced' },
  // Instantly has no documented 'complaint' webhook type as of Oct 2026; these
  // are handled defensively in case one is added later, or a custom label is
  // used for it, so a complaint is never missed once Instantly starts sending it.
  email_complaint: { reason: 'complained', subscription_status: 'unsubscribed' },
  lead_complaint: { reason: 'complained', subscription_status: 'unsubscribed' },
  spam_complaint: { reason: 'complained', subscription_status: 'unsubscribed' },
}

export function externalId(e: InstantlyEvent): string {
  const key = [e.event_type, normalizeEmail(e.lead_email) ?? '', e.campaign_id ?? '', e.timestamp ?? '', e.email_id ?? '', e.step ?? '', e.variant ?? ''].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 40)
}

export function nextStage(current: Stage, event: string): Stage | null {
  const target = STAGE_FOR_EVENT[event]
  if (!target || target === current) return null
  if (target === 'do_not_contact') return target
  if (TERMINAL.includes(current)) return null
  if (target === 'lost' || target === 'won') return target
  return STAGES.indexOf(target) > STAGES.indexOf(current) ? target : null
}

/** Strip bulky HTML bodies before storing; keep text and metadata. */
function compact(e: InstantlyEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) {
    if (k === 'email_html' || k === 'reply_html') continue
    out[k] = typeof v === 'string' && v.length > 20000 ? `${v.slice(0, 20000)}…` : v
  }
  return out
}

/** The dashboard campaign already linked to this Instantly campaign id, if any (lp.campaigns.instantly_campaign_id). */
async function dashboardCampaignFor(q: Queryable, instantlyCampaignId: string | null | undefined): Promise<number | null> {
  if (!instantlyCampaignId) return null
  const { rows } = await q.query<{ id: number }>('select id from lp.campaigns where instantly_campaign_id = $1 limit 1', [instantlyCampaignId])
  return rows[0]?.id ?? null
}

/**
 * Add a global suppression for this email (idempotent) plus subscription_status
 * and a consent_log row. Plain SQL on purpose — lib/suppressions/store.ts is a
 * parallel PR and is not imported here.
 */
async function addGlobalSuppression(q: Queryable, email: string, contactId: number | null, reason: string, subscriptionStatus: string, note: string) {
  await q.query(
    `insert into lp.suppressions (email_norm, campaign_id, reason, source, note)
     values ($1, null, $2, 'instantly_webhook', $3)
     on conflict (email_norm, coalesce(campaign_id, 0)) where email_norm is not null and lifted_at is null do nothing`,
    [email, reason, note],
  )
  if (contactId) {
    await q.query('update lp.contacts set subscription_status = $2 where id = $1 and subscription_status is distinct from $2', [contactId, subscriptionStatus])
    await q.query(
      `insert into lp.consent_log (contact_id, status, source, evidence, actor) values ($1, $2, 'instantly_webhook', $3, 'instantly-ai')`,
      [contactId, subscriptionStatus, note],
    )
  }
}

export type IngestResult = { stored: boolean; duplicate: boolean; event_type: string; contact_id: number | null; task_id: number | null }

export async function ingestInstantlyEvent(db: Db, e: InstantlyEvent): Promise<IngestResult> {
  const type = typeof e.event_type === 'string' ? e.event_type.trim().slice(0, 80) : ''
  if (!type) throw new Error('event_type is required')
  const email = normalizeEmail(e.lead_email)
  const occurred = e.timestamp && !Number.isNaN(Date.parse(e.timestamp)) ? new Date(e.timestamp) : new Date()
  const ext = externalId(e)

  return db.tx(async (q: Queryable) => {
    const c = email
      ? await q.query<{ id: number; company_id: number | null; status: string }>('select id, company_id, status from lp.contacts where email_norm = $1', [email])
      : { rows: [] as { id: number; company_id: number | null; status: string }[] }
    const contact = c.rows[0] ?? null

    const ins = await q.query<{ id: number }>(
      `insert into lp.campaign_touches (contact_id, company_id, email, campaign_id, campaign_name, event_type, occurred_at, source, external_id, payload)
       values ($1, $2, $3, $4, $5, $6, $7, 'instantly_webhook', $8, $9)
       on conflict (source, external_id) where external_id is not null do nothing returning id`,
      [contact?.id ?? null, contact?.company_id ?? null, email, e.campaign_id ?? null, e.campaign_name ?? null, type, occurred, ext, JSON.stringify(compact(e))],
    )
    if (!ins.rows[0]) return { stored: false, duplicate: true, event_type: type, contact_id: contact?.id ?? null, task_id: null }

    if (contact) {
      const status = CONTACT_STATUS_FOR_EVENT[type]
      if (status && status !== contact.status) {
        // Never walk a reply/unsubscribe back to "sent".
        const rank = ['sent', 'replied', 'bounced', 'do-not-contact']
        if (!(status === 'sent' && rank.indexOf(contact.status) > 0)) {
          await q.query('update lp.contacts set status = $2 where id = $1', [contact.id, status])
        }
      }
      if (type === 'lead_unsubscribed') await q.query('update lp.contacts set do_not_contact = true where id = $1', [contact.id])
      if (type === 'email_bounced') {
        await q.query("update lp.contacts set verification_status = 'invalid' where id = $1", [contact.id])
        await q.query(
          `insert into lp.verification_results (contact_id, email, provider, result, verdict, raw) values ($1, $2, 'manual', 'bounced_in_campaign', 'invalid', $3)`,
          [contact.id, email, JSON.stringify({ campaign_id: e.campaign_id ?? null, event: type })],
        )
      }
      if (contact.company_id) {
        const co = await q.query<{ stage: Stage }>('select stage from lp.companies where id = $1', [contact.company_id])
        const next = co.rows[0] ? nextStage(co.rows[0].stage, type) : null
        if (next) await q.query('update lp.companies set stage = $2 where id = $1', [contact.company_id, next])
      }
    }

    // Global suppression on unsubscribe / hard bounce / complaint, before the lead event (so the
    // lead event's own props can note it happened; order doesn't matter for correctness, both are
    // in this same transaction).
    const supp = SUPPRESSION_FOR_EVENT[type]
    let suppressed = false
    if (supp && email) {
      await addGlobalSuppression(q, email, contact?.id ?? null, supp.reason, supp.subscription_status, `Instantly webhook: ${type}${e.campaign_name ? ` (${e.campaign_name})` : ''}`)
      suppressed = true
    }

    // Lead event: same dedupe_key shape the 0018 backfill used ('touch:<campaign_touches.id>'),
    // so a backfilled touch and a live redelivery of the same touch can never double up — the
    // touch insert above already returns early on a retried delivery, before this ever runs.
    const dashboardCampaignId = await dashboardCampaignFor(q, e.campaign_id)
    const eventType = INSTANTLY_EVENT_TYPE_MAP[type] ?? 'custom'
    await emitLeadEvent(q, {
      type: eventType,
      company_id: contact?.company_id ?? null,
      contact_id: contact?.id ?? null,
      email,
      campaign_id: dashboardCampaignId,
      instantly_campaign_id: e.campaign_id ?? null,
      step: typeof e.step === 'number' ? e.step : null,
      source: 'instantly_webhook',
      actor: 'instantly-ai',
      occurred_at: occurred,
      dedupe_key: `touch:${ins.rows[0].id}`,
      props: eventType === 'custom' ? { instantly_type: type, suppressed } : { suppressed },
    })

    let taskId: number | null = null
    if (REPLY_EVENTS.has(type)) {
      const proj = await q.query<{ id: number }>("select id from lp.projects where name = 'Reply desk'")
      const who = email ?? 'unknown sender'
      const t = await q.query<{ id: number }>(
        `insert into lp.tasks (kind, title, project_id, company_id, payload, priority, dedupe_key, created_by)
         values ('review_reply', $1, $2, $3, $4, 5, $5, 'instantly-ai')
         on conflict do nothing returning id`,
        [
          `${type === 'reply_received' ? 'Reply' : type.replace(/_/g, ' ')} from ${who}${e.campaign_name ? ` (${e.campaign_name})` : ''}`.slice(0, 300),
          proj.rows[0]?.id ?? null,
          contact?.company_id ?? null,
          JSON.stringify({ touch_id: ins.rows[0].id, email, campaign_id: e.campaign_id ?? null, unibox_url: e.unibox_url ?? null, snippet: e.reply_text_snippet ?? null }),
          `reply:${email ?? ext}`,
        ],
      )
      taskId = t.rows[0]?.id ?? null
    }

    const label: Record<string, string> = {
      reply_received: 'replied',
      auto_reply_received: 'sent an auto-reply',
      email_bounced: 'bounced',
      lead_unsubscribed: 'unsubscribed',
      lead_interested: 'was marked interested',
      lead_meeting_booked: 'booked a meeting',
      email_sent: 'was emailed',
    }
    if (type !== 'email_sent' && type !== 'email_opened' && type !== 'link_clicked' && type !== 'email_link_clicked') {
      await logEvent(q, {
        actor: 'instantly-ai',
        kind: `webhook.${type}`,
        summary: `${email ?? 'A lead'} ${label[type] ?? `→ ${type}`}${e.campaign_name ? ` in "${e.campaign_name}"` : ''}${e.reply_text_snippet ? `: "${String(e.reply_text_snippet).slice(0, 140)}"` : ''}`,
        entity_type: contact ? 'contact' : null,
        entity_id: contact?.id ?? null,
        task_id: taskId,
      })
    }
    return { stored: true, duplicate: false, event_type: type, contact_id: contact?.id ?? null, task_id: taskId }
  }, 'instantly-ai')
}
