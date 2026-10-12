/**
 * "Ask to change" for Instantly-backed numbers (plan item 1.3).
 *
 * Emails sent / opens / replies are counted from lp.lead_events, which only
 * Instantly's own events write. Editing them in place would make the dashboard
 * say something Instantly never said, so they are never inline-editable.
 * Instead a person files a request into the existing approval queue
 * (lp.approvals, "Needs your OK" on Activity) with the field, the stored
 * current value, the proposed value and a reason. No migration: it is an
 * approval of action 'other' whose payload.kind is 'instantly_value_change'.
 * Only one request per lead + field may be pending at a time, and only an
 * Owner can decide one (lib/ops/core.ts decideApproval).
 * Approving records the decision (who, when, note) — it does not rewrite the
 * count; the number changes only when Instantly's data does.
 */
import type { Db } from '../db/types'
import { requestApprovalIn, type ApprovalRow } from '../ops/core'
import { RegistryError } from './registry'

export const INSTANTLY_METRICS = {
  steps: { label: 'Emails sent', event: 'email_sent' },
  opens: { label: 'Opens', event: 'email_opened' },
  replies: { label: 'Replies', event: 'reply_received' },
} as const
export type InstantlyMetric = keyof typeof INSTANTLY_METRICS

export const VALUE_CHANGE_KIND = 'instantly_value_change'

export interface ValueChangePayload {
  kind: typeof VALUE_CHANGE_KIND
  entity_type: 'company'
  entity_id: number
  company_name: string
  campaign_id: number
  campaign_name: string
  field: InstantlyMetric
  field_label: string
  /** Counted from lp.lead_events when the request was filed — never the number the browser sent. */
  current: number
  proposed: number
  reason: string
}

export function isValueChangePayload(p: unknown): p is ValueChangePayload {
  return !!p && typeof p === 'object' && (p as { kind?: unknown }).kind === VALUE_CHANGE_KIND
}

export async function requestValueChange(
  db: Db,
  actor: string,
  input: { companyId: unknown; campaignId: unknown; field: unknown; proposed: unknown; reason: unknown },
): Promise<{ approval: ApprovalRow; payload: ValueChangePayload }> {
  const companyId = Number(input.companyId)
  const campaignId = Number(input.campaignId)
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new RegistryError('company id must be a positive integer.')
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) throw new RegistryError('campaign id must be a positive integer.')
  if (typeof input.field !== 'string' || !(input.field in INSTANTLY_METRICS)) {
    throw new RegistryError(`field must be one of: ${Object.keys(INSTANTLY_METRICS).join(', ')}.`)
  }
  const field = input.field as InstantlyMetric
  const rawProposed = typeof input.proposed === 'string' ? input.proposed.trim() : input.proposed
  const proposed = rawProposed === '' || rawProposed === null || rawProposed === undefined ? NaN : Number(rawProposed)
  if (!Number.isSafeInteger(proposed) || proposed < 0) throw new RegistryError('The proposed value must be a whole number, 0 or more.')
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) throw new RegistryError('Say why the number is wrong.')
  if (reason.length > 1000) throw new RegistryError('The reason is too long (max 1000 characters).')

  const co = await db.query<{ name: string }>('select name from lp.companies where id = $1', [companyId])
  if (!co.rows[0]) throw new RegistryError('No lead found for that id.', 404)
  const camp = await db.query<{ name: string }>('select name from lp.campaigns where id = $1', [campaignId])
  if (!camp.rows[0]) throw new RegistryError('No campaign found for that id.', 404)
  const { label, event } = INSTANTLY_METRICS[field]
  const cur = await db.query<{ n: number }>(
    'select count(*)::int as n from lp.lead_events where campaign_id = $1 and company_id = $2 and type = $3',
    [campaignId, companyId, event],
  )
  const current = Number(cur.rows[0].n)
  if (current === proposed) throw new RegistryError(`${label} already reads ${current}; nothing to ask for.`)

  const payload: ValueChangePayload = {
    kind: VALUE_CHANGE_KIND,
    entity_type: 'company',
    entity_id: companyId,
    company_name: co.rows[0].name,
    campaign_id: campaignId,
    campaign_name: camp.rows[0].name,
    field,
    field_label: label,
    current,
    proposed,
    reason,
  }
  const summary = `Change ${label} for ${payload.company_name} in ${payload.campaign_name} from ${current} to ${proposed}: ${reason}`
  // One pending request per lead + field. The advisory lock serializes two requests for the same
  // lead + field, so the check and the insert can't race (no migration, no unique index needed).
  const approval = await db.tx(async (q) => {
    await q.query('select pg_advisory_xact_lock(hashtext($1))', [`${VALUE_CHANGE_KIND}:${companyId}:${field}`])
    const dup = await q.query<{ id: number }>(
      `select id from lp.approvals
        where status = 'pending' and (expires_at is null or expires_at > now())
          and payload->>'kind' = $1 and payload->>'entity_id' = $2 and payload->>'field' = $3
        limit 1`,
      [VALUE_CHANGE_KIND, String(companyId), field],
    )
    if (dup.rows[0]) throw new RegistryError(`There's already a pending request to change ${label} for this lead.`, 409)
    return requestApprovalIn(q, actor, { action: 'other', summary, payload })
  }, actor)
  return { approval, payload }
}
