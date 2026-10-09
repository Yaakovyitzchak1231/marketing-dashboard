/**
 * "Link to Instantly": a campaign can point at one Instantly campaign (an id, stored only).
 *
 * Nothing here calls Instantly. Pushing steps or leads is a REQUEST: a row in
 * lp.campaign_instantly_requests that waits for a human.
 *   Leads go through #46's approval gate (lib/instantly/gate.ts):
 *     - an agent's request queues an lp.instantly_actions row (awaiting_approval) and a pending
 *       lp.approvals row, which shows in Activity > Needs your OK; approval_id points at it.
 *     - a person's own request opens the usual Add to Instantly preview (/leads/instantly?action=…),
 *       where they confirm it themselves (a person can't approve their own Needs-your-OK row).
 *   Either way only a human's confirm sends, and the leads are re-scored with the campaign's
 *   rules at that moment (only Ready leads upload).
 *   Steps: #46 has no "write a sequence" change, so a steps request stays a record for a person
 *   to copy into Instantly. Nothing sends steps.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { columnsOf, getCampaign, loadCampaignLeads } from './adapter.ts'
import { listSteps, StepsError } from './store.ts'
import { requestAddLeads } from '../instantly/gate.ts'
import { buildAddPreview, savePreview } from '../instantly/add-leads.ts'

// Instantly v2 campaign ids are UUIDs.
const INSTANTLY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PushRequest {
  id: number
  campaign_id: number
  instantly_campaign_id: string
  what: 'steps' | 'leads' | 'steps_and_leads'
  payload: { steps?: unknown[]; lead_count?: number; sample?: unknown[]; instantly_action_id?: number; confirm_url?: string; ready_count?: number }
  note: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  /** The Needs-your-OK row (#46) holding the leads part, when an agent asked. */
  approval_id: number | null
  /** Where the leads part stands in the approval gate (lp.instantly_actions.status), when there is one. */
  instantly_status?: string | null
  requested_by: string
  decided_by: string | null
  decided_at: Date | null
  decision_note: string | null
  created_at: Date
}

export function parseInstantlyId(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  // Accept a pasted Instantly URL too: .../campaign/<uuid>/...
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s)
  if (!m || (!INSTANTLY_ID.test(s) && !/instantly\.ai/i.test(s))) throw new StepsError('That is not an Instantly campaign id (it looks like 8-4-4-4-12 letters and digits) or an Instantly campaign link.')
  return m[0].toLowerCase()
}

async function actorKind(q: Queryable, actor: string): Promise<string | null> {
  const { rows } = await q.query<{ kind: string }>('select kind from lp.actors where id = $1', [actor])
  return rows[0]?.kind ?? null
}

/** Store (or clear, with null) the Instantly campaign this campaign is linked to. Only a human links. */
export async function linkInstantly(db: Db, actor: string, campaignId: number, raw: unknown) {
  const next = parseInstantlyId(raw)
  return db.tx(async (q) => {
    if ((await actorKind(q, actor)) !== 'human') throw new StepsError('Only a person can link a campaign to Instantly. Agents can ask in the activity feed.', 403)
    const c = await getCampaign(q, campaignId)
    if (!c) throw new StepsError(`No campaign ${campaignId}.`, 404)
    if (c.instantly_campaign_id === next) return { campaign: c, changed: false }
    if (next) {
      const { rows: other } = await q.query<{ id: number; name: string }>(
        `select id, name from lp.campaigns where instantly_campaign_id = $1 and id <> $2 limit 1`,
        [next, campaignId],
      )
      if (other[0]) throw new StepsError(`That Instantly campaign is already linked to "${other[0].name}". Unlink it there first.`, 409)
    }
    const stamp = (await columnsOf(q, 'campaigns')).has('updated_by') ? ', updated_by = $3' : ''
    await q.query(
      `update lp.campaigns set instantly_campaign_id = $2${stamp}, instantly_linked_at = case when $2::text is null then null else now() end,
              instantly_linked_by = case when $2::text is null then null else $3 end where id = $1`,
      [campaignId, next, actor],
    )
    await logEvent(q, {
      actor,
      kind: next ? 'campaign.instantly_linked' : 'campaign.instantly_unlinked',
      summary: next
        ? `Linked campaign "${c.name}" to Instantly campaign ${next}${c.instantly_campaign_id ? ` (was ${c.instantly_campaign_id})` : ''}. Nothing was sent.`
        : `Unlinked campaign "${c.name}" from Instantly campaign ${c.instantly_campaign_id}.`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { changes: [{ field: 'instantly_campaign_id', old: c.instantly_campaign_id, new: next }] },
    })
    return { campaign: await getCampaign(q, campaignId), changed: true }
  }, actor)
}

/**
 * Ask to push this campaign's steps and/or its leads to the linked Instantly campaign.
 * Creates a pending request only; no Instantly call. Humans and agents can ask.
 */
export async function requestPush(db: Db, actor: string, campaignId: number, input: { what?: unknown; note?: unknown }): Promise<PushRequest> {
  const r = await recordPush(db, actor, campaignId, input)
  if (r.what === 'steps' || !(r.payload.lead_count ?? 0)) return r
  return queueLeads(db, actor, r)
}

/**
 * Hand the leads part to #46's approval gate. An agent's ask lands in Needs your OK;
 * a person's ask becomes an Add to Instantly preview they confirm. Nothing is sent here.
 */
async function queueLeads(db: Db, actor: string, r: PushRequest): Promise<PushRequest> {
  const c = await getCampaign(db, r.campaign_id)
  const leads = await loadCampaignLeads(db, r.campaign_id, { limit: 5000 })
  const companyIds = [...new Set(leads.map((l) => l.company_id))]
  const reason = r.note ?? `Push the leads of campaign "${c?.name ?? r.campaign_id}" (request #${r.id})`
  let approvalId: number | null = null
  let actionId: number
  let readyCount: number
  try {
    if ((await actorKind(db, actor)) === 'human') {
      const p = await buildAddPreview(db, { campaign_id: r.instantly_campaign_id, campaign_name: c?.name ?? null, company_ids: companyIds }, null)
      const row = await savePreview(db, actor, p)
      actionId = Number(row.id)
      readyCount = p.ready.length
    } else {
      const out = await requestAddLeads(db, actor, { campaign_id: r.instantly_campaign_id, campaign_name: c?.name ?? null, company_ids: companyIds, reason }, null)
      approvalId = Number(out.approval.id)
      actionId = Number(out.action.id)
      readyCount = out.preview.ready_count ?? 0
    }
  } catch (e) {
    await db.query(`update lp.campaign_instantly_requests set status = 'cancelled', decided_at = now(), decision_note = $2 where id = $1`, [
      r.id,
      `Could not queue the leads: ${(e as Error).message}`.slice(0, 1000),
    ])
    throw new StepsError(`Could not queue the leads for an OK: ${(e as Error).message}`, 409)
  }
  const payload = { ...r.payload, instantly_action_id: actionId, ready_count: readyCount, confirm_url: `/leads/instantly?action=${actionId}` }
  const { rows } = await db.query<PushRequest>(
    `update lp.campaign_instantly_requests set approval_id = $2, payload = $3 where id = $1 returning *`,
    [r.id, approvalId, JSON.stringify(payload)],
  )
  return norm(rows[0])
}

const norm = (r: PushRequest): PushRequest => ({ ...r, id: Number(r.id), campaign_id: Number(r.campaign_id), approval_id: r.approval_id == null ? null : Number(r.approval_id) })

async function recordPush(db: Db, actor: string, campaignId: number, input: { what?: unknown; note?: unknown }): Promise<PushRequest> {
  const what = input.what == null || input.what === '' ? 'steps_and_leads' : String(input.what)
  if (!['steps', 'leads', 'steps_and_leads'].includes(what)) throw new StepsError('what must be steps, leads, or steps_and_leads.')
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : null
  return db.tx(async (q) => {
    const c = await getCampaign(q, campaignId)
    if (!c) throw new StepsError(`No campaign ${campaignId}.`, 404)
    if (!c.instantly_campaign_id) throw new StepsError('Link this campaign to an Instantly campaign first.', 409)
    const steps = await listSteps(q, campaignId)
    if (what !== 'leads' && !steps.length) throw new StepsError('This campaign has no steps to push yet.', 409)
    const leads = what === 'steps' ? [] : await loadCampaignLeads(q, campaignId, { limit: 2000 })
    const { rows: open } = await q.query<{ id: number }>(
      `select id from lp.campaign_instantly_requests where campaign_id = $1 and status = 'pending' and what = $2`,
      [campaignId, what],
    )
    if (open[0]) throw new StepsError(`A request like this is already waiting for a person's OK (#${open[0].id}).`, 409)
    const payload = {
      steps: what === 'leads' ? undefined : steps.map((s) => ({ step_number: s.step_number, variant: s.variant, subject: s.subject, body: s.body, delay_days: s.delay_days })),
      // Only Ready leads are ever uploaded; the approval step re-checks each lead with the rules evaluator before anything is sent.
      lead_count: what === 'steps' ? undefined : leads.length,
      sample: what === 'steps' ? undefined : leads.slice(0, 5).map((l) => ({ company_id: l.company_id, name: l.company_name, email: l.email })),
    }
    const { rows } = await q.query<PushRequest>(
      `insert into lp.campaign_instantly_requests (campaign_id, instantly_campaign_id, what, payload, note, requested_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [campaignId, c.instantly_campaign_id, what, JSON.stringify(payload), note, actor],
    )
    const r = norm(rows[0])
    const parts = [what !== 'leads' ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : null, what !== 'steps' ? `${leads.length} lead${leads.length === 1 ? '' : 's'} (Ready only)` : null].filter(Boolean)
    await logEvent(q, {
      actor,
      kind: 'campaign.instantly_push_requested',
      summary: `Asked to push ${parts.join(' and ')} of campaign "${c.name}" to Instantly. Waiting for a person's OK; nothing was sent.`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { request_id: r.id, instantly_campaign_id: c.instantly_campaign_id, what, changes: [{ field: 'push_request', old: null, new: 'pending' }] },
    })
    return r
  }, actor)
}

/**
 * The campaign's push requests. A request whose leads went to the approval gate shows the
 * gate's outcome: approved / rejected in Needs your OK, or the preview confirmed / cancelled.
 */
export async function listPushRequests(q: Queryable, campaignId: number): Promise<PushRequest[]> {
  const { rows } = await q.query<PushRequest & { approval_status: string | null }>(
    `select r.*, a.status as approval_status, ia.status as instantly_status
       from lp.campaign_instantly_requests r
       left join lp.approvals a on a.id = r.approval_id
       left join lp.instantly_actions ia on ia.id = nullif(r.payload->>'instantly_action_id', '')::bigint
      where r.campaign_id = $1 order by r.created_at desc, r.id desc limit 20`,
    [campaignId],
  )
  return rows.map(({ approval_status, ...r }) => {
    let status = r.status
    if (status === 'pending') {
      if (approval_status === 'approved' || ['approved', 'sending', 'done', 'unknown', 'failed'].includes(r.instantly_status ?? '')) status = 'approved'
      else if (approval_status === 'rejected' || r.instantly_status === 'rejected') status = 'rejected'
      else if (approval_status === 'expired' || approval_status === 'cancelled' || r.instantly_status === 'cancelled') status = 'cancelled'
    }
    return { ...norm(r), status }
  })
}

/** Withdraw a pending request (whoever asked, or a person). Nothing is sent either way. */
export async function cancelPush(db: Db, actor: string, campaignId: number, requestId: number): Promise<PushRequest> {
  return db.tx(async (q) => {
    const { rows } = await q.query<PushRequest>(`select * from lp.campaign_instantly_requests where id = $1 and campaign_id = $2`, [requestId, campaignId])
    const r = rows[0]
    if (!r) throw new StepsError(`No request ${requestId} on this campaign.`, 404)
    if (r.status !== 'pending') throw new StepsError(`Request ${requestId} is already ${r.status}.`, 409)
    if (r.requested_by !== actor && (await actorKind(q, actor)) !== 'human') throw new StepsError('Only whoever asked, or a person, can withdraw this request.', 403)
    const { rows: up } = await q.query<PushRequest>(
      `update lp.campaign_instantly_requests set status = 'cancelled', decided_at = now(), decided_by = $2 where id = $1 returning *`,
      [requestId, actor],
    )
    // Withdraw the leads part from the approval gate too, if nobody has decided it yet.
    const actionId = Number((r.payload as { instantly_action_id?: unknown } | null)?.instantly_action_id) || null
    if (r.approval_id != null) {
      await q.query(`update lp.approvals set status = 'cancelled', decided_at = now(), decision_note = 'withdrawn with the campaign push request' where id = $1 and status = 'pending'`, [r.approval_id])
    }
    if (actionId) {
      await q.query(`update lp.instantly_actions set status = 'cancelled', finished_at = now() where id = $1 and status in ('preview', 'awaiting_approval')`, [actionId])
    }
    await logEvent(q, {
      actor,
      kind: 'campaign.instantly_push_cancelled',
      summary: `Withdrew the Instantly push request #${requestId}. Nothing was sent.`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { request_id: requestId, changes: [{ field: 'status', old: 'pending', new: 'cancelled' }] },
    })
    return norm(up[0])
  }, actor)
}
