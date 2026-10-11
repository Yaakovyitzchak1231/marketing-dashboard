/**
 * Instantly webhook events -> lp.campaign_touches (+ lead status, reply desk, activity log).
 *
 * Payload shape per developer.instantly.ai/webhook-events (read Oct 8, 2026):
 * base fields timestamp, event_type, workspace, campaign_id, campaign_name; optional
 * lead_email, email_account, unibox_url, step, variant, is_first, email_id,
 * email_subject/text/html, reply_text_snippet, reply_subject, reply_text, reply_html,
 * plus any lead fields. Custom labels arrive as event_type verbatim.
 */
import { createHash } from 'node:crypto'
import type { Db, Queryable } from '@/lib/db/types'
import { normalizeEmail } from '@/lib/leads/normalize'
import { STAGES, type Stage } from '@/lib/leads/types'
import { logEvent } from '@/lib/ops/events'

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
