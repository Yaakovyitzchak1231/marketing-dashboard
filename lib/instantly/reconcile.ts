/**
 * Nightly reconcile (plan 1.6): per-lead activity pulled from Instantly's
 * read-only API to fill gaps left by a webhook delivery that never arrived
 * (Instantly does not guarantee webhook delivery; this is the safety net).
 *
 * Same lp.lead_events table, same dedupe story as the live webhook
 * (lib/webhooks/instantly.ts): every insert here carries a stable
 * dedupe_key, so running this job twice — or running it after the webhook
 * already recorded the same thing — inserts nothing new (emitLeadEvents'
 * `on conflict (dedupe_key) do nothing`).
 *
 * Two read-only Instantly calls (lib/instantly/endpoints.ts, ported from the
 * per-lead logic in collector/collect_instantly.py's workspace-wide passes):
 *
 *  - POST /leads/list (listLeadsByEmail) for every known contact's CURRENT
 *    Instantly lead state (lt_interest_status) -> interested / not interested
 *    / meeting booked / other labels. The dedupe key keys off the current
 *    status (`reconcile:lead:<instantly lead id>:<status>`), so a lead that
 *    moves from Interested to Meeting Booked gets a new event, but reading
 *    the same status twice is a no-op.
 *  - GET /emails?email_type=received (listLatestThreadEmails) for the latest
 *    received message per thread, workspace-wide -> catches a reply the
 *    webhook never got. Dedupe key keys off Instantly's own email id
 *    (`reconcile:email:<id>`).
 *
 * Scope on purpose: only contacts lp.lead_events already has an
 * instantly_webhook or backfill row for within the lookback window — the
 * webhook already knows about them, so this job is "catch what it missed",
 * not "learn about every Instantly lead from scratch" (that is a bigger,
 * separate job and not what 1.6 asks for).
 *
 * Instantly interest-status codes with no entry in INTEREST_EVENT (0 Out of
 * Office, -2 Wrong Person, -3 Lost, -4 No Show, and anything future) are never
 * dropped: they land as type 'custom' with the numeric code in props, the
 * same "never drop it" rule the webhook follows for an unmapped event_type.
 */
import type { Db, Queryable } from '@/lib/db/types'
import type { InstantlyClient } from '@/lib/instantly/client'
import { listLatestThreadEmails, listLeadsByEmail } from '@/lib/instantly/endpoints'
import type { ApiEmail, ApiLead } from '@/lib/instantly/types'
import { emitLeadEvents, type EmitLeadEventInput } from '@/lib/events/emit'
import { normalizeEmail } from '@/lib/leads/normalize'

/** ApiLead.lt_interest_status -> lp.event_types key. See file doc for the rest. */
const INTEREST_EVENT: Record<number, string> = {
  1: 'lead_interested',
  2: 'meeting_booked',
  3: 'meeting_booked',
  4: 'lead_interested', // Won: no separate type yet; props.lt_interest_status=4 says which
  [-1]: 'lead_not_interested',
}

export interface ReconcileSummary {
  contacts_checked: number
  leads_fetched: number
  threads_fetched: number
  events_considered: number
  events_inserted: number
  events_skipped_duplicate: number
  errors: string[]
}

interface ReconcileContact {
  id: number
  company_id: number | null
  email_norm: string
}

/** Contacts the webhook (or the 0018 backfill) has already recorded Instantly activity for, recently. */
async function knownContacts(q: Queryable, sinceDays: number): Promise<ReconcileContact[]> {
  const { rows } = await q.query<ReconcileContact>(
    `select distinct c.id, c.company_id, c.email_norm
       from lp.lead_events e
       join lp.contacts c on c.id = e.contact_id
      where e.source in ('instantly_webhook', 'backfill')
        and e.occurred_at > now() - ($1 || ' days')::interval
        and c.email_norm is not null
        and c.merged_into is null`,
    [String(sinceDays)],
  )
  return rows
}

/** lp.campaigns rows already linked to any of these Instantly campaign ids. */
async function dashboardCampaignsFor(q: Queryable, instantlyIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const ids = [...new Set(instantlyIds)]
  if (!ids.length) return map
  const { rows } = await q.query<{ id: number; instantly_campaign_id: string }>(
    `select id, instantly_campaign_id from lp.campaigns where instantly_campaign_id = any($1::text[])`,
    [ids],
  )
  for (const r of rows) map.set(r.instantly_campaign_id, r.id)
  return map
}

function leadEventInput(
  lead: ApiLead,
  contact: ReconcileContact,
  email: string,
  dashboardCampaignId: number | null,
): EmitLeadEventInput | null {
  const status = lead.lt_interest_status
  if (status == null) return null
  // No reliable timestamp -> skip rather than date a months-old status "today" (emitLeadEvents
  // falls back to now()), which would skew windowed traits and the 24h panel.
  const occurredAt = lead.timestamp_last_reply ?? lead.timestamp_last_contact ?? null
  if (!occurredAt) return null
  const type = INTEREST_EVENT[status] ?? 'custom'
  return {
    type,
    company_id: contact.company_id,
    contact_id: contact.id,
    email,
    campaign_id: dashboardCampaignId,
    instantly_campaign_id: lead.campaign ?? null,
    source: 'instantly_reconcile',
    actor: 'instantly-ai',
    occurred_at: occurredAt,
    dedupe_key: `reconcile:lead:${lead.id}:${status}`,
    props: { lt_interest_status: status, reconciled: true, ...(type === 'custom' ? { instantly_type: `lt_interest_status:${status}` } : {}) },
  }
}

/** Out-of-office / autoresponder subjects (the API's own flag wins when present). */
const AUTO_REPLY_SUBJECT = /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|away from (the )?office|on vacation|on leave|abwesenheit|absence)\b/i

/** True when Instantly (or the message itself) says this is an automatic reply, not a person. */
export function isAutoReply(email: ApiEmail): boolean {
  const flag = email.is_auto_reply
  if (flag === true || flag === 1) return true
  if (flag === false || flag === 0) return false
  return AUTO_REPLY_SUBJECT.test(email.subject ?? '')
}

function replyEventInput(
  email: ApiEmail,
  contact: ReconcileContact,
  addr: string,
  dashboardCampaignId: number | null,
): EmitLeadEventInput {
  return {
    // Same split the webhook makes: an autoresponder is not a human reply (reply rate).
    type: isAutoReply(email) ? 'auto_reply_received' : 'reply_received',
    company_id: contact.company_id,
    contact_id: contact.id,
    email: addr,
    campaign_id: dashboardCampaignId,
    instantly_campaign_id: email.campaign_id ?? null,
    source: 'instantly_reconcile',
    actor: 'instantly-ai',
    occurred_at: email.timestamp_email ?? email.timestamp_created ?? null,
    dedupe_key: `reconcile:email:${email.id}`,
    props: { reconciled: true, instantly_email_id: email.id, thread_id: email.thread_id ?? null },
  }
}

/**
 * Run one reconcile pass. Never throws on an Instantly API failure for either
 * call — it records the message in `errors` and reconciles whatever the other
 * call returned, so one flaky endpoint doesn't block the other's catch-up.
 */
export async function reconcileInstantly(db: Db, client: InstantlyClient, opts: { sinceDays?: number } = {}): Promise<ReconcileSummary> {
  const sinceDays = opts.sinceDays ?? 14
  const summary: ReconcileSummary = {
    contacts_checked: 0,
    leads_fetched: 0,
    threads_fetched: 0,
    events_considered: 0,
    events_inserted: 0,
    events_skipped_duplicate: 0,
    errors: [],
  }

  // Reads and the (possibly slow, paged) Instantly calls happen OUTSIDE any transaction;
  // only the inserts run in one, in chunks.
  {
    const q: Queryable = db
    const contacts = await knownContacts(q, sinceDays)
    summary.contacts_checked = contacts.length
    if (!contacts.length) return summary
    const byEmail = new Map(contacts.map((c) => [c.email_norm, c]))

    let leads: ApiLead[] = []
    try {
      leads = await listLeadsByEmail(client, contacts.map((c) => c.email_norm))
    } catch (err) {
      summary.errors.push(`listLeadsByEmail: ${(err as Error).message}`)
    }
    summary.leads_fetched = leads.length

    let threads: ApiEmail[] = []
    try {
      threads = (await listLatestThreadEmails(client)).items.filter((e) => e.ue_type === 2) // 2 = Received: the lead spoke last
    } catch (err) {
      summary.errors.push(`listLatestThreadEmails: ${(err as Error).message}`)
    }
    summary.threads_fetched = threads.length

    const campaignIds = [
      ...leads.map((l) => l.campaign).filter((x): x is string => Boolean(x)),
      ...threads.map((e) => e.campaign_id).filter((x): x is string => Boolean(x)),
    ]
    const campaignMap = await dashboardCampaignsFor(q, campaignIds)

    const inputs: EmitLeadEventInput[] = []
    for (const lead of leads) {
      const email = normalizeEmail(lead.email ?? null)
      const contact = email ? byEmail.get(email) : undefined
      if (!email || !contact) continue
      const input = leadEventInput(lead, contact, email, lead.campaign ? (campaignMap.get(lead.campaign) ?? null) : null)
      if (input) inputs.push(input)
    }
    for (const email of threads) {
      const addr = normalizeEmail(email.lead ?? null)
      const contact = addr ? byEmail.get(addr) : undefined
      if (!addr || !contact) continue
      inputs.push(replyEventInput(email, contact, addr, email.campaign_id ? (campaignMap.get(email.campaign_id) ?? null) : null))
    }

    summary.events_considered = inputs.length
    // The webhook keys its rows on `touch:<id>`, so `on conflict (dedupe_key)` alone never
    // catches a reply/status the webhook already saved. Drop those here first.
    const fresh = await withoutWebhookDuplicates(q, inputs)
    if (fresh.length) {
      const results = await db.tx(async (tq) => {
        const out: Awaited<ReturnType<typeof emitLeadEvents>> = []
        for (let i = 0; i < fresh.length; i += INSERT_CHUNK) out.push(...(await emitLeadEvents(tq, fresh.slice(i, i + INSERT_CHUNK))))
        return out
      }, 'instantly-ai')
      summary.events_inserted = results.filter((r) => r.inserted).length
    }
    summary.events_skipped_duplicate = inputs.length - summary.events_inserted
    return summary
  }
}

/** Rows per multi-row insert (12 params a row stays far below Postgres' 65,535-param limit). */
const INSERT_CHUNK = 500

const REPLY_TYPES = new Set(['reply_received', 'auto_reply_received'])
/** A reconciled reply within this long of a webhook reply from the same contact is the same reply. */
const REPLY_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Inputs the webhook (or the 0018 backfill) has NOT already recorded:
 *  - a reply: no webhook reply/auto-reply event from that contact carrying the same Instantly
 *    email id, or within REPLY_MATCH_WINDOW_MS of it;
 *  - an interest-status event: no webhook event of the same type for that contact (and the
 *    same Instantly campaign, when both name one).
 */
export async function withoutWebhookDuplicates(q: Queryable, inputs: EmitLeadEventInput[]): Promise<EmitLeadEventInput[]> {
  const contactIds = [...new Set(inputs.map((i) => i.contact_id).filter((x): x is number => x != null))]
  if (!contactIds.length) return inputs
  const { rows } = await q.query<{ contact_id: string | number; type: string; instantly_campaign_id: string | null; occurred_at: Date | string; email_id: string | null }>(
    `select contact_id, type, instantly_campaign_id, occurred_at, props->>'instantly_email_id' as email_id
       from lp.lead_events
      where contact_id = any($1::bigint[]) and source in ('instantly_webhook', 'backfill')
        and type = any($2::text[])`,
    [contactIds, [...new Set([...inputs.map((i) => i.type), ...REPLY_TYPES])]],
  )
  const byContact = new Map<number, typeof rows>()
  for (const r of rows) {
    const k = Number(r.contact_id)
    const list = byContact.get(k) ?? []
    list.push(r)
    byContact.set(k, list)
  }
  return inputs.filter((i) => {
    const existing = i.contact_id != null ? byContact.get(Number(i.contact_id)) : undefined
    if (!existing?.length) return true
    if (REPLY_TYPES.has(i.type)) {
      const emailId = (i.props as { instantly_email_id?: string } | undefined)?.instantly_email_id ?? null
      const at = i.occurred_at ? new Date(i.occurred_at).getTime() : NaN
      return !existing.some((r) =>
        REPLY_TYPES.has(r.type) &&
        ((emailId != null && r.email_id === emailId) ||
          (Number.isFinite(at) && Math.abs(new Date(r.occurred_at).getTime() - at) <= REPLY_MATCH_WINDOW_MS)))
    }
    return !existing.some((r) =>
      r.type === i.type &&
      (r.instantly_campaign_id == null || i.instantly_campaign_id == null || r.instantly_campaign_id === i.instantly_campaign_id))
  })
}
