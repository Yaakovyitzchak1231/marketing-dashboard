/**
 * The approval gate in front of Instantly.
 *
 * Agents (ops token) never change Instantly. When one wants to add leads to a
 * campaign, or pause / resume a campaign, it calls one of the request
 * functions here. That only:
 *   1. builds the preview a human would see (who would be added, who is left
 *      out and why; or the campaign status change),
 *   2. stores it as an lp.instantly_actions row in 'awaiting_approval',
 *   3. opens a pending lp.approvals row ("Needs your OK" on the Activity page)
 *      linked to that row, and notifies every human,
 *   4. writes the activity log with the agent as actor.
 * Nothing leaves the box.
 *
 * decideInstantlyApproval is the human's side: Approve (with confirm) runs
 * exactly the stored change through the same code the human's own buttons use
 * (confirmAddLeads / runApprovedSwitch); Reject needs a reason and records it.
 * Each step is logged with who did it.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { OpsError } from '@/lib/ops/core'
import {
  EXCLUDE_WORDS,
  buildAddPreview,
  confirmAddLeads,
  getAction,
  runApprovedSwitch,
  type ActionRow,
  type AddPreview,
  type ExcludeReason,
  type PreviewLead,
} from '@/lib/instantly/add-leads'
import type { InstantlyWriter } from '@/lib/instantly/writer'
import type { Batch } from '@/lib/rules/evaluate'

const CAMPAIGN_ID = /^[0-9a-f-]{8,64}$/i
const DEFAULT_EXPIRY_HOURS = 72
const SAMPLE_SIZE = 5

export type InstantlyKind = 'add_leads' | 'pause' | 'resume'

export interface GateApproval {
  id: number
  action: string
  summary: string
  payload: Record<string, unknown>
  status: string
  requested_by: string
  decided_by: string | null
  decision_note: string | null
  task_id: number | null
  instantly_action_id: number | null
  created_at: Date
  decided_at: Date | null
  expires_at: Date | null
}

/** What the queue shows for one request. Stored on the approval's payload. */
export interface GatePreview {
  instantly_action_id: number
  kind: InstantlyKind
  campaign_id: string
  campaign_name: string | null
  reason: string | null
  /** add_leads */
  ready_count?: number
  excluded_count?: number
  excluded_by_reason?: Partial<Record<ExcludeReason, number>>
  sample?: { contact_id: number; company_id: number; company: string; name: string | null; email: string | null }[]
  instantly_checked?: boolean
  instantly_note?: string | null
  /** The change, as plain before -> after lines. */
  diff: { field: string; from: string; to: string }[]
}

function campaignId(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!CAMPAIGN_ID.test(s)) throw new OpsError('campaign_id must be an Instantly campaign id (the uuid in the campaign URL)')
  return s
}
function cleanName(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null
}
function cleanReason(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : null
}

async function agentName(q: Queryable, actor: string): Promise<{ name: string; kind: string }> {
  const { rows } = await q.query<{ display_name: string; kind: string; active: boolean }>('select display_name, kind, active from lp.actors where id = $1', [actor])
  if (!rows[0] || !rows[0].active) throw new OpsError(`unknown or inactive actor '${actor}'`, 403)
  return { name: rows[0].display_name, kind: rows[0].kind }
}

function sampleOf(leads: PreviewLead[]) {
  return leads.slice(0, SAMPLE_SIZE).map((l) => ({
    contact_id: l.contact_id,
    company_id: l.company_id,
    company: l.company,
    name: [l.first_name, l.last_name].filter(Boolean).join(' ') || null,
    email: l.email,
  }))
}

function countReasons(leads: PreviewLead[]): Partial<Record<ExcludeReason, number>> {
  const out: Partial<Record<ExcludeReason, number>> = {}
  for (const l of leads) if (l.excluded) out[l.excluded] = (out[l.excluded] ?? 0) + 1
  return out
}

/** Company ids for the leads an agent named (by company id and/or email). */
async function resolveCompanies(q: Queryable, input: { company_ids?: unknown; emails?: unknown }): Promise<{ ids: number[]; unknownEmails: string[] }> {
  const ids = new Set<number>()
  if (Array.isArray(input.company_ids)) {
    for (const v of input.company_ids) {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) throw new OpsError('company_ids must be positive integers')
      ids.add(n)
    }
  }
  const unknownEmails: string[] = []
  if (Array.isArray(input.emails) && input.emails.length) {
    const emails = [...new Set(input.emails.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))].slice(0, 5000)
    const { rows } = await q.query<{ email_norm: string; company_id: number }>(
      'select email_norm, company_id from lp.contacts where email_norm = any($1::text[])',
      [emails],
    )
    const found = new Set(rows.map((r) => r.email_norm))
    for (const r of rows) ids.add(r.company_id)
    for (const e of emails) if (!found.has(e)) unknownEmails.push(e)
  }
  if (ids.size === 0) throw new OpsError('name the leads: company_ids (numbers) and/or emails already in the dashboard')
  if (ids.size > 5000) throw new OpsError('at most 5000 leads per request')
  return { ids: [...ids], unknownEmails }
}

async function openApproval(
  q: Queryable,
  actor: string,
  who: string,
  row: ActionRow,
  preview: Omit<GatePreview, 'instantly_action_id'>,
  summary: string,
  opts: { task_id?: number | null; expires_in_hours?: number },
): Promise<GateApproval> {
  const hours = Number.isFinite(Number(opts.expires_in_hours)) && Number(opts.expires_in_hours) > 0 ? Math.min(Math.floor(Number(opts.expires_in_hours)), 24 * 14) : DEFAULT_EXPIRY_HOURS
  const payload: GatePreview = { instantly_action_id: row.id, ...preview }
  const { rows } = await q.query<GateApproval>(
    `insert into lp.approvals (action, summary, payload, requested_by, task_id, expires_at, instantly_action_id)
     values ('send', $1, $2, $3, $4, now() + make_interval(hours => $5::int), $6) returning *`,
    [summary.slice(0, 1000), JSON.stringify(payload), actor, opts.task_id ?? null, hours, row.id],
  )
  const ap = rows[0]
  await q.query('update lp.instantly_actions set approval_id = $2 where id = $1', [row.id, ap.id])
  if (opts.task_id) await q.query("update lp.tasks set status = 'needs_approval' where id = $1 and status in ('claimed', 'running')", [opts.task_id])
  await logEvent(q, {
    actor,
    kind: 'approval.requested',
    summary: `${who} is asking to ${summary.charAt(0).toLowerCase()}${summary.slice(1)} (waiting for a human OK; nothing sent)`.slice(0, 2000),
    entity_type: 'approval',
    entity_id: ap.id,
    task_id: opts.task_id ?? null,
    data: payload,
  })
  const humans = await q.query<{ id: string }>("select id from lp.actors where kind = 'human' and active")
  for (const h of humans.rows) {
    await q.query(
      `insert into lp.notifications (recipient, kind, summary, task_id, created_by) values ($1, 'approval', $2, $3, $4)`,
      [h.id, `${who} needs your OK: ${summary}`.slice(0, 500), opts.task_id ?? null, actor],
    )
  }
  return ap
}

export interface RequestResult {
  approval: GateApproval
  action: ActionRow
  preview: GatePreview
  executed: false
  note: string
}

const QUEUED_NOTE = 'Queued for a human OK in the dashboard (Activity > Needs your OK). Nothing was sent to Instantly. Poll get_approval or get_instantly_action for the outcome.'

/** An agent asks to add leads to an Instantly campaign. Never sends. */
export async function requestAddLeads(
  db: Db,
  actor: string,
  input: { campaign_id: unknown; campaign_name?: unknown; company_ids?: unknown; emails?: unknown; batch?: unknown; reason?: unknown; task_id?: number | null; expires_in_hours?: number },
  lookupInInstantly: ((emails: string[]) => Promise<string[]>) | null,
): Promise<RequestResult> {
  const cid = campaignId(input.campaign_id)
  const name = cleanName(input.campaign_name)
  const reason = cleanReason(input.reason)
  const me = await agentName(db, actor)
  const { ids, unknownEmails } = await resolveCompanies(db, input)
  // The Instantly lookup is a read (POST /leads/list); it runs outside the transaction.
  if (input.batch != null && input.batch !== 'standard' && input.batch !== 'role-inbox') throw new OpsError('batch must be standard or role-inbox')
  const batch: Batch = input.batch === 'role-inbox' ? 'role-inbox' : 'standard'
  const p: AddPreview = await buildAddPreview(db, { campaign_id: cid, campaign_name: name, company_ids: ids, batch }, lookupInInstantly)
  const preview: Omit<GatePreview, 'instantly_action_id'> = {
    kind: 'add_leads',
    campaign_id: cid,
    campaign_name: name,
    reason,
    ready_count: p.ready.length,
    excluded_count: p.excluded.length,
    excluded_by_reason: countReasons(p.excluded),
    sample: sampleOf(p.ready),
    instantly_checked: p.instantlyChecked,
    instantly_note: [p.instantlyNote, unknownEmails.length ? `${unknownEmails.length} email(s) are not in the dashboard and were ignored.` : null].filter(Boolean).join(' ') || null,
    diff: [{ field: `Leads in ${name ? `“${name}”` : 'the campaign'}`, from: 'as now', to: `+${p.ready.length} (Instantly skips any already in the workspace)` }],
  }
  const what = name ? `“${name}”` : `campaign ${cid}`
  const summary = `Add ${p.ready.length} lead${p.ready.length === 1 ? '' : 's'} to ${what} in Instantly${p.excluded.length ? ` (${p.excluded.length} left out)` : ''}`
  const out = await db.tx(async (q) => {
    const { rows } = await q.query<ActionRow>(
      `insert into lp.instantly_actions (kind, campaign_id, campaign_name, contact_ids, preview, status, created_by, requested_reason)
       values ('add_leads', $1, $2, $3::bigint[], $4, 'awaiting_approval', $5, $6) returning *`,
      [cid, name, p.ready.map((l) => l.contact_id), JSON.stringify(p), actor, reason],
    )
    const ap = await openApproval(q, actor, me.name, rows[0], preview, summary, input)
    return { approval: ap, action: { ...rows[0], approval_id: ap.id } }
  }, actor)
  return { ...out, preview: { instantly_action_id: out.action.id, ...preview }, executed: false, note: QUEUED_NOTE }
}

/** An agent asks to pause or resume a campaign. Never sends. */
export async function requestCampaignSwitch(
  db: Db,
  actor: string,
  input: { kind: 'pause' | 'resume'; campaign_id: unknown; campaign_name?: unknown; reason?: unknown; current_status?: string | null; task_id?: number | null; expires_in_hours?: number },
): Promise<RequestResult> {
  if (input.kind !== 'pause' && input.kind !== 'resume') throw new OpsError('kind must be pause or resume')
  const cid = campaignId(input.campaign_id)
  const name = cleanName(input.campaign_name)
  const reason = cleanReason(input.reason)
  const me = await agentName(db, actor)
  const to = input.kind === 'pause' ? 'paused' : 'active (sending)'
  const preview: Omit<GatePreview, 'instantly_action_id'> = {
    kind: input.kind,
    campaign_id: cid,
    campaign_name: name,
    reason,
    diff: [{ field: 'Campaign status', from: input.current_status || 'not read', to }],
  }
  const what = name ? `“${name}”` : `campaign ${cid}`
  const summary = `${input.kind === 'pause' ? 'Pause' : 'Resume'} ${what} in Instantly`
  const out = await db.tx(async (q) => {
    const { rows } = await q.query<ActionRow>(
      `insert into lp.instantly_actions (kind, campaign_id, campaign_name, preview, status, created_by, requested_reason)
       values ($1, $2, $3, $4, 'awaiting_approval', $5, $6) returning *`,
      [input.kind, cid, name, JSON.stringify(preview), actor, reason],
    )
    const ap = await openApproval(q, actor, me.name, rows[0], preview, summary, input)
    return { approval: ap, action: { ...rows[0], approval_id: ap.id } }
  }, actor)
  return { ...out, preview: { instantly_action_id: out.action.id, ...preview }, executed: false, note: QUEUED_NOTE }
}

export interface DecideOutcome {
  approval: GateApproval
  action: ActionRow
  executed: boolean
  ok: boolean
  message: string
}

async function humanOrThrow(q: Queryable, actor: string): Promise<void> {
  const { rows } = await q.query<{ kind: string; active: boolean }>('select kind, active from lp.actors where id = $1', [actor])
  if (!rows[0] || !rows[0].active || rows[0].kind !== 'human') throw new OpsError('only a signed-in human can approve or reject an Instantly change', 403)
}

/**
 * Re-check an add-leads request right before it runs: anyone who stopped
 * qualifying since the agent asked (marked do-not-contact, failed
 * verification, touched by a campaign) is dropped from the send.
 */
async function refreshReady(db: Db, row: ActionRow): Promise<{ kept: number; dropped: { contact_id: number; reason: string }[] }> {
  const p = row.preview
  if (!p) return { kept: 0, dropped: [] }
  const companyIds = [...new Set(p.ready.map((l) => l.company_id))]
  const fresh = await buildAddPreview(db, { campaign_id: row.campaign_id, campaign_name: row.campaign_name, company_ids: companyIds, batch: p.batch === 'role-inbox' ? 'role-inbox' : 'standard' }, null)
  const ok = new Set(fresh.ready.map((l) => l.contact_id))
  const why = new Map(fresh.excluded.map((l) => [l.contact_id, l.excluded ? EXCLUDE_WORDS[l.excluded] : 'no longer the best contact']))
  const keep = p.ready.filter((l) => ok.has(l.contact_id))
  const dropped = p.ready.filter((l) => !ok.has(l.contact_id)).map((l) => ({ contact_id: l.contact_id, reason: why.get(l.contact_id) ?? 'no longer qualifies' }))
  if (dropped.length) {
    const next: AddPreview = { ...p, ready: keep, excluded: [...p.excluded, ...p.ready.filter((l) => !ok.has(l.contact_id))] }
    await db.query('update lp.instantly_actions set preview = $2, contact_ids = $3::bigint[] where id = $1', [row.id, JSON.stringify(next), keep.map((l) => l.contact_id)])
  }
  return { kept: keep.length, dropped }
}

/**
 * The human's Approve / Reject on an Instantly request.
 * Approve needs confirm === true and a writer (Instantly actions on); it then
 * runs exactly the stored change. Reject needs a reason.
 */
export async function decideInstantlyApproval(
  db: Db,
  writer: InstantlyWriter | null,
  actor: string,
  approvalId: number,
  decision: 'approved' | 'rejected',
  opts: { note?: string | null; confirm?: boolean },
): Promise<DecideOutcome> {
  const note = cleanReason(opts.note)
  if (decision === 'rejected' && !note) throw new OpsError('say why you are rejecting it (the agent reads this)')
  if (decision === 'approved' && opts.confirm !== true) throw new OpsError('not confirmed; nothing was sent', 400)
  if (decision === 'approved' && !writer) throw new OpsError('Instantly actions are off on this deploy (no key, or INSTANTLY_ACTIONS=off). Nothing was sent; the request is still waiting.', 409)

  const decided = await db.tx(async (q) => {
    await humanOrThrow(q, actor)
    const cur = await q.query<GateApproval>('select * from lp.approvals where id = $1 for update', [approvalId])
    const ap = cur.rows[0]
    if (!ap) throw new OpsError(`approval ${approvalId} not found`, 404)
    if (!ap.instantly_action_id) throw new OpsError(`approval ${approvalId} is not an Instantly change`, 400)
    if (ap.requested_by === actor) throw new OpsError('you cannot decide your own request', 403)
    if (ap.status !== 'pending') throw new OpsError(`approval ${approvalId} is already ${ap.status}`, 409)
    const act = await q.query<ActionRow>('select * from lp.instantly_actions where id = $1 for update', [ap.instantly_action_id])
    const row = act.rows[0]
    if (!row) throw new OpsError('the queued Instantly change is missing', 404)
    if (ap.expires_at && new Date(ap.expires_at).getTime() < Date.now()) {
      await q.query("update lp.approvals set status = 'expired' where id = $1", [approvalId])
      await q.query("update lp.instantly_actions set status = 'cancelled', error = 'approval expired', finished_at = now() where id = $1 and status = 'awaiting_approval'", [row.id])
      await logEvent(q, { actor, kind: 'approval.expired', summary: `Request expired before anyone decided: ${ap.summary}`, entity_type: 'approval', entity_id: ap.id })
      return { expired: true as const }
    }
    if (row.status !== 'awaiting_approval') throw new OpsError(`that Instantly change is already ${row.status}`, 409)
    const upd = await q.query<GateApproval>(
      'update lp.approvals set status = $2, decided_by = $3, decision_note = $4, decided_at = now() where id = $1 returning *',
      [approvalId, decision, actor, note],
    )
    const next = decision === 'approved' ? 'approved' : 'rejected'
    const a2 = await q.query<ActionRow>(
      `update lp.instantly_actions set status = $2, decided_by = $3, decision_note = $4,
              finished_at = case when $2 = 'rejected' then now() else finished_at end
        where id = $1 returning *`,
      [row.id, next, actor, note],
    )
    const humanName = (await q.query<{ display_name: string }>('select display_name from lp.actors where id = $1', [actor])).rows[0]?.display_name ?? actor
    await logEvent(q, {
      actor,
      kind: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      summary: decision === 'approved'
        ? `${humanName} approved: ${ap.summary}${note ? ` (“${note}”)` : ''}`
        : `${humanName} rejected: ${ap.summary}. Why: ${note}`,
      entity_type: 'approval',
      entity_id: ap.id,
      task_id: ap.task_id,
      data: { instantly_action_id: row.id, requested_by: ap.requested_by },
    })
    await q.query(
      `insert into lp.notifications (recipient, kind, summary, task_id, created_by) values ($1, 'approval', $2, $3, $4)`,
      [ap.requested_by, `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${ap.summary}${note ? ` (${note})` : ''}`.slice(0, 500), ap.task_id, actor],
    )
    if (ap.task_id) {
      await q.query("update lp.tasks set status = 'running' where id = $1 and status = 'needs_approval'", [ap.task_id])
    }
    return { expired: false as const, approval: upd.rows[0], action: a2.rows[0] }
  }, actor)

  if (decided.expired) throw new OpsError(`approval ${approvalId} expired; nothing was sent`, 409)
  if (decision === 'rejected') {
    return { approval: decided.approval, action: decided.action, executed: false, ok: true, message: 'Rejected. Nothing was sent; the agent sees your reason.' }
  }

  const row = decided.action
  if (row.kind === 'add_leads') {
    const fresh = await refreshReady(db, row)
    const r = await confirmAddLeads(db, writer!, row.id, actor, { from: 'approved' })
    const dropNote = fresh.dropped.length ? ` ${fresh.dropped.length} dropped since the request (no longer qualify).` : ''
    return { approval: decided.approval, action: r.action, executed: r.sent, ok: r.action.status === 'done', message: r.message + dropNote }
  }
  const r = await runApprovedSwitch(db, writer!, actor, row.id)
  return { approval: decided.approval, action: r.action, executed: r.ok, ok: r.ok, message: r.message }
}

/** One queued change, for the agent polling for its outcome. */
export async function getInstantlyAction(q: Queryable, id: number): Promise<ActionRow> {
  const row = await getAction(q, id)
  if (!row) throw new OpsError(`Instantly change ${id} not found`, 404)
  return row
}

/** Expire stale requests so the queue only shows live ones (called when the queue renders). */
export async function expireStaleInstantlyRequests(db: Db): Promise<number> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; instantly_action_id: number }>(
      `update lp.approvals set status = 'expired'
        where status = 'pending' and instantly_action_id is not null and expires_at is not null and expires_at < now()
        returning id, instantly_action_id`,
    )
    if (rows.length) {
      await q.query(
        `update lp.instantly_actions set status = 'cancelled', error = 'approval expired', finished_at = now()
          where id = any($1::bigint[]) and status = 'awaiting_approval'`,
        [rows.map((r) => r.instantly_action_id)],
      )
      await logEvent(q, { actor: 'system', kind: 'approval.expired', summary: `${rows.length} Instantly request(s) expired with no decision; nothing was sent` })
    }
    return rows.length
  }, 'system')
}
